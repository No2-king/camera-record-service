'use strict';
/**
 * 录像下载服务 —— 独立 HTTP 服务，零第三方依赖
 *
 * 只做一件事：把摄像头/NVR 上某段历史录像取下来，转成 mp4 交给你。
 *
 * 启动：
 *   node server.js                      默认端口 3001
 *   set RECORD_PORT=3001 && node server.js
 *
 * 接口：
 *   GET  /                     服务信息（浏览器直接打开）
 *   GET  /health               健康检查（含 ffmpeg 可用性）
 *   POST /search               查某时间段有没有录像
 *   POST /download             发起下载，返回 taskId
 *   GET  /progress?taskId=xx   查进度
 *   GET  /file?name=xx.mp4     取成品文件
 *   GET  /tasks                任务列表
 *
 * 环境变量：
 *   RECORD_PORT        监听端口，默认 3001
 *   RECORD_DIR         成品目录，默认 ./downloads
 *   RECORD_TZ          时区，默认 8（北京）
 *   RECORD_CONCURRENCY 并发任务数，默认 2
 *   FFMPEG_PATH        ffmpeg.exe 路径（不设则自动找 ../../tools/ffmpeg.exe）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { HikIsapiClient, toUtcDate, trackId, explainIsapiError } = require('./lib/isapi');
const ffmpeg = require('./lib/ffmpeg');

const PORT = Number(process.env.RECORD_PORT || 3001);
const HOST = process.env.RECORD_HOST || '0.0.0.0';
const OUT_DIR = process.env.RECORD_DIR || path.join(__dirname, 'downloads');
const DEFAULT_TZ = Number(process.env.RECORD_TZ || 8);
const MAX_CONCURRENT = Number(process.env.RECORD_CONCURRENCY || 2);
const TASK_TTL_MS = 2 * 60 * 60 * 1000;

fs.mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------------ 任务管理

const tasks = new Map();
const queue = [];
let running = 0;

function newTask(params) {
    const task = {
        id: crypto.randomUUID().slice(0, 8),
        status: 'queued',            // queued | running | done | failed
        percent: 0,
        message: '排队中',
        file: null,
        size: 0,
        segments: 0,
        error: null,
        params,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    tasks.set(task.id, task);
    return task;
}

function update(task, patch) {
    Object.assign(task, patch, { updatedAt: Date.now() });
}

function schedule(task, job) {
    queue.push({ task, job });
    pump();
}

function pump() {
    while (running < MAX_CONCURRENT && queue.length) {
        const { task, job } = queue.shift();
        running++;
        Promise.resolve()
            .then(job)
            .catch((e) => update(task, { status: 'failed', error: e?.message || String(e) }))
            .finally(() => { running--; pump(); });
    }
}

setInterval(() => {
    const now = Date.now();
    for (const [id, t] of tasks) {
        if (now - t.updatedAt > TASK_TTL_MS && (t.status === 'done' || t.status === 'failed')) {
            tasks.delete(id);
        }
    }
}, 10 * 60 * 1000).unref();

// ------------------------------------------------------------ 参数处理

function pickHost(b) {
    if (b.cameraIp || b.host) return String(b.cameraIp || b.host).trim();
    if (b.xaddr) {
        const m = String(b.xaddr).match(/^https?:\/\/([^/:]+)/);
        if (m) return m[1];
    }
    throw new Error('缺少 cameraIp 或 xaddr');
}

function pickAuth(b) {
    const userName = b.userName || b.username;
    const password = b.password ?? b.pass;
    if (!userName || password == null) throw new Error('缺少 userName / password');
    return { userName, password };
}

function parseParams(b) {
    const host = pickHost(b);
    const { userName, password } = pickAuth(b);
    if (!b.start || !b.end) throw new Error('缺少 start / end');

    const channel = Number(b.channel || 1);
    const stream = b.stream || 'main';
    const tz = b.tz != null ? Number(b.tz) : DEFAULT_TZ;
    const isapiPort = Number(b.isapiPort || process.env.ISAPI_PORT || 80);

    const startUtc = toUtcDate(b.start, tz);
    const endUtc = toUtcDate(b.end, tz);
    if (endUtc <= startUtc) throw new Error('end 必须晚于 start');

    return {
        host, isapiPort, userName, password,
        channel, stream, track: trackId(channel, stream),
        start: b.start, end: b.end, tz,
        startUtc, endUtc,
        startStamp: compact(b.start), endStamp: timePart(b.end),
    };
}

function compact(s) {
    const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s));
    if (!m) return 'unknown';
    return `${m[1]}${m[2]}${m[3]}_${m[4]}${m[5]}${m[6] || '00'}`;
}

function timePart(s) {
    return compact(s).slice(9);
}

function safeName(name) {
    const n = path.basename(String(name || ''));
    return /^[A-Za-z0-9_.-]+$/.test(n) ? n : '';
}

/** 只解析设备连接信息（不需要时间段），供 /storage、/deviceinfo 这类自检接口使用 */
function parseDevice(b) {
    const host = pickHost(b);
    const { userName, password } = pickAuth(b);
    return {
        host,
        isapiPort: Number(b.isapiPort || process.env.ISAPI_PORT || 80),
        userName,
        password,
    };
}

const newClient = (p) => new HikIsapiClient(p.host, p.isapiPort, p.userName, p.password);

// ------------------------------------------------------------ 下载流程

async function runDownload(task, p) {
    update(task, { status: 'running', message: '正在搜索录像段', percent: 2 });

    const client = newClient(p);
    let segs;
    try {
        segs = await client.search(p.track, p.startUtc, p.endUtc);
    } catch (e) {
        // 把海康的 subStatusCode 翻成人话，直接告诉用户该查什么
        throw new Error(explainIsapiError(e.message));
    }
    if (!segs.length) {
        throw new Error('该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）');
    }
    update(task, { segments: segs.length, message: `找到 ${segs.length} 段，开始下载`, percent: 5 });

    const work = path.join(OUT_DIR, `tmp_${task.id}_${Date.now()}`);
    fs.mkdirSync(work, { recursive: true });

    try {
        const mp4s = [];
        for (let i = 0; i < segs.length; i++) {
            const stem = String(i).padStart(3, '0');
            const ps = path.join(work, `${stem}.ps`);

            update(task, { message: `下载第 ${i + 1}/${segs.length} 段` });
            let n = 0;
            try {
                n = await client.download(segs[i].uri, ps);
            } catch (e) {
                console.warn(`[下载] 第 ${i + 1} 段失败: ${e.message}`);
            }

            if (n > 0) {
                update(task, { message: `转码第 ${i + 1}/${segs.length} 段` });
                const mp4 = path.join(work, `${stem}.mp4`);
                if (await ffmpeg.toMp4(ps, mp4)) mp4s.push(mp4);
            }
            try { fs.unlinkSync(ps); } catch { /* ignore */ }

            update(task, { percent: 5 + Math.round(((i + 1) / segs.length) * 65) });
        }

        if (!mp4s.length) throw new Error('下载到的流为空，可能是该段录像不存在或已被覆盖');

        update(task, { message: '合并视频', percent: 96 });

        const name = `ch${p.channel}_${p.startStamp}_${p.endStamp}.mp4`;
        const finalFile = path.join(OUT_DIR, name);
        try { fs.unlinkSync(finalFile); } catch { /* ignore */ }

        if (!(await ffmpeg.concat(mp4s, finalFile))) throw new Error('合并 mp4 失败');

        update(task, {
            status: 'done',
            percent: 100,
            message: '完成',
            file: name,
            size: fs.statSync(finalFile).size,
        });
        console.log(`[下载] 完成: ${name} (${(fs.statSync(finalFile).size / 1048576).toFixed(1)} MB)`);
    } finally {
        try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// ------------------------------------------------------------ HTTP 层

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
};

function json(res, obj, code = 200) {
    const body = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        ...CORS,
    });
    res.end(body);
}

async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('请求体不是合法 JSON');
    }
}

const PAGE = (port) => `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>录像下载服务</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.7;color:#222}
h1{font-size:20px}code{background:#f2f2f2;padding:2px 6px;border-radius:4px;font-size:13px}
table{border-collapse:collapse;width:100%;margin:16px 0}td,th{border:1px solid #ddd;padding:8px 10px;text-align:left;font-size:14px}
th{background:#fafafa}.ok{color:#0a0}</style></head><body>
<h1>录像下载服务</h1>
<p>状态：<span class="ok">运行中</span>　端口 <code>${port}</code></p>
<table><tr><th>方法</th><th>路径</th><th>说明</th></tr>
<tr><td>GET</td><td><code>/health</code></td><td>健康检查，含 ffmpeg 可用性</td></tr>
<tr><td>POST</td><td><code>/search</code></td><td>查某时间段有没有录像</td></tr>
<tr><td>POST</td><td><code>/download</code></td><td>发起下载，返回 taskId</td></tr>
<tr><td>GET</td><td><code>/progress?taskId=</code></td><td>查进度</td></tr>
<tr><td>GET</td><td><code>/file?name=</code></td><td>取成品 mp4</td></tr>
<tr><td>GET</td><td><code>/tasks</code></td><td>任务列表</td></tr>
<tr><td>POST</td><td><code>/deviceinfo</code></td><td>设备型号（自检）</td></tr>
<tr><td>POST</td><td><code>/storage</code></td><td>存储介质状态（自检，排查"没有录像"）</td></tr>
</table>
<p style="color:#666;font-size:13px">请求体示例：<code>{"cameraIp":"192.168.1.100","isapiPort":80,"userName":"admin","password":"xxx","channel":1,"start":"2026-10-15 08:00:00","end":"2026-10-15 09:00:00"}</code></p>
</body></html>`;

const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
    }

    try {
        // 首页
        if (req.method === 'GET' && p === '/') {
            const body = Buffer.from(PAGE(PORT), 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, ...CORS });
            return res.end(body);
        }

        // 健康检查
        if (req.method === 'GET' && p === '/health') {
            return json(res, {
                success: true,
                service: 'record-service',
                port: PORT,
                outDir: OUT_DIR,
                ffmpegPath: ffmpeg.FFMPEG,
                ffmpegAvailable: await ffmpeg.available(),
                running,
                queued: queue.length,
                tasks: tasks.size,
            });
        }

        // 自检：设备型号信息
        if (req.method === 'POST' && p === '/deviceinfo') {
            let d;
            try {
                d = parseDevice(await readJson(req));
            } catch (e) {
                return json(res, { success: false, error: e.message }, 400);
            }
            try {
                const info = await newClient(d).deviceInfo();
                return json(res, { success: true, device: d.host, ...info });
            } catch (e) {
                return json(res, {
                    success: false,
                    error: explainIsapiError(e.message),
                    raw: e.message,
                }, 502);
            }
        }

        // 自检：存储介质状态 —— 回答"这台设备到底有没有地方存录像"
        if (req.method === 'POST' && p === '/storage') {
            let d;
            try {
                d = parseDevice(await readJson(req));
            } catch (e) {
                return json(res, { success: false, error: e.message }, 400);
            }
            try {
                const volumes = await newClient(d).storage();
                const usable = volumes.filter((v) => v.status && /ok|normal|idle|running/i.test(v.status));
                return json(res, {
                    success: true,
                    device: d.host,
                    count: volumes.length,
                    volumes,
                    conclusion: volumes.length === 0
                        ? '设备没有报告任何存储介质 —— 这台设备本身不存录像'
                          + '（无 SD 卡、未接 NAS）。若录像实际在 NVR 上，'
                          + '请把 cameraIp 改成 NVR 的 IP 再检索。'
                        : (usable.length
                            ? `发现 ${usable.length} 个可用存储介质，可以尝试检索录像。`
                            : '发现了存储介质，但状态不是 ok —— 可能未格式化或已损坏。'),
                });
            } catch (e) {
                console.error('[存储] 查询失败:', e.message);
                const connFail = /无法连接设备/.test(e.message);
                return json(res, {
                    success: false,
                    error: explainIsapiError(e.message),
                    raw: e.message,
                    conclusion: connFail
                        ? '连不上设备 —— 检查 cameraIp 与 isapiPort 是否正确'
                          + '（海康的 ISAPI 与 ONVIF 共用同一个 HTTP 端口，出厂默认 80；'
                          + '若设备网页端口被改过，这里要填改后的值），以及网络是否可达。'
                        : '设备不支持查询存储状态，或返回了错误。'
                          + '若为 notSupport / 403，说明这台设备可能不是海康，或固件过旧。',
                }, 502);
            }
        }

        // 查录像段
        if (req.method === 'POST' && p === '/search') {
            let params;
            try {
                params = parseParams(await readJson(req));
            } catch (e) {
                return json(res, { success: false, error: e.message }, 400);
            }
            try {
                const segs = await newClient(params).search(params.track, params.startUtc, params.endUtc);
                return json(res, {
                    success: true,
                    count: segs.length,
                    segments: segs.map((s) => ({ start: s.start, end: s.end })),
                    hint: segs.length ? undefined : '该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）',
                });
            } catch (e) {
                console.error('[搜索] 失败:', e.message);
                return json(res, {
                    success: false,
                    error: explainIsapiError(e.message),
                    raw: e.message,
                }, 502);
            }
        }

        // 发起下载
        if (req.method === 'POST' && p === '/download') {
            let params;
            try {
                params = parseParams(await readJson(req));
            } catch (e) {
                return json(res, { success: false, error: e.message }, 400);
            }
            const task = newTask({
                host: params.host, channel: params.channel, stream: params.stream,
                start: params.start, end: params.end,
            });
            schedule(task, () => runDownload(task, params));
            return json(res, { success: true, taskId: task.id, status: task.status });
        }

        // 查进度
        if (req.method === 'GET' && p === '/progress') {
            const task = tasks.get(u.searchParams.get('taskId') || '');
            if (!task) return json(res, { success: false, error: '任务不存在或已过期' }, 404);
            return json(res, {
                success: true,
                taskId: task.id,
                status: task.status,
                percent: task.percent,
                message: task.message,
                file: task.file,
                size: task.size,
                segments: task.segments,
                error: task.error,
            });
        }

        // 任务列表
        if (req.method === 'GET' && p === '/tasks') {
            return json(res, {
                success: true,
                running,
                queued: queue.length,
                tasks: [...tasks.values()].sort((a, b) => b.createdAt - a.createdAt),
            });
        }

        // 取文件
        if (req.method === 'GET' && p === '/file') {
            const name = safeName(u.searchParams.get('name'));
            const file = path.join(OUT_DIR, name);
            if (!name || !file.startsWith(OUT_DIR) || !fs.existsSync(file)) {
                return json(res, { success: false, error: '文件不存在' }, 404);
            }
            res.writeHead(200, {
                'Content-Type': 'video/mp4',
                'Content-Length': fs.statSync(file).size,
                'Content-Disposition': `attachment; filename="${name}"`,
                ...CORS,
            });
            return fs.createReadStream(file).pipe(res);
        }

        json(res, { success: false, error: 'not found' }, 404);
    } catch (e) {
        console.error('[服务] 未捕获错误:', e);
        json(res, { success: false, error: e?.message || String(e) }, 500);
    }
});

server.listen(PORT, HOST, () => {
    console.log('========================================');
    console.log('  录像下载服务  record-service');
    console.log('========================================');
    console.log(`  监听地址 : ${HOST}:${PORT}`);
    console.log(`  成品目录 : ${OUT_DIR}`);
    console.log(`  ffmpeg   : ${ffmpeg.FFMPEG}`);
    console.log(`  并发上限 : ${MAX_CONCURRENT}`);
    console.log('----------------------------------------');
    console.log('  接口:');
    console.log('    GET  /                    服务信息页');
    console.log('    GET  /health              健康检查');
    console.log('    POST /search              查录像段');
    console.log('    POST /download            发起下载');
    console.log('    GET  /progress?taskId=    查进度');
    console.log('    GET  /file?name=          取文件');
    console.log('    GET  /tasks               任务列表');
    console.log('    POST /deviceinfo          设备型号（自检）');
    console.log('    POST /storage             存储状态（自检）');
    console.log('========================================');
});
