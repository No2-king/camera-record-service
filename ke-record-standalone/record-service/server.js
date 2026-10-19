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
 *   DELETE /task?id=xx         删除任务（连它的成品 mp4 一起删）
 *
 * 环境变量：
 *   RECORD_PORT        监听端口，默认 3001
 *   RECORD_DIR         成品目录，默认 ./downloads
 *   RECORD_TZ          时区偏移小时数，默认 0（不换算，选什么就是什么）
 *   RECORD_CONCURRENCY 并发任务数，默认 2
 *   RECORD_RETENTION_DAYS 成品保留天数，默认 7（按任务发起下载的时间算）
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
// 时区偏移默认 0：选什么时间就按什么时间发给设备，不做换算。
// 设备本身按本地时间处理 ISAPI 的 startTime/endTime，这里再减 8 小时
// 会让下载到的画面比选的早 8 小时（踩过）。确实需要换算时传 tz 参数或设 RECORD_TZ。
const DEFAULT_TZ = Number(process.env.RECORD_TZ || 0);
const MAX_CONCURRENT = Number(process.env.RECORD_CONCURRENCY || 2);

// 成品保留策略：默认 7 天，按任务「发起下载的时间」算。
// 超期后定时器连任务记录带 mp4 一起删，避免磁盘被慢慢撑满。
const RETENTION_DAYS = Math.max(1, Number(process.env.RECORD_RETENTION_DAYS || 7));
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;        // 每小时扫一次过期项
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;      // 临时工作目录超过 1 天视为残留

fs.mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------------ 任务管理

const tasks = new Map();
const queue = [];
let running = 0;

// 任务表落盘：内存是易失的，服务一重启就全没了；而 mp4 是实打实躺在磁盘上的。
// 不落盘的话重启后文件还在但没人认领，也没法按「下载时间」算保留期。
const TASKS_FILE = path.join(OUT_DIR, 'tasks.json');

function loadTasks() {
    let arr;
    try {
        arr = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
    } catch {
        return 0;                    // 首次运行，还没有 tasks.json
    }
    if (!Array.isArray(arr)) return 0;
    let n = 0;
    for (const t of arr) {
        if (!t || !t.id) continue;
        // 上次进程退出时还没跑完的任务，实际已经中断了
        if (t.status === 'queued' || t.status === 'running') {
            t.status = 'failed';
            t.error = '服务重启，任务中断';
            t.message = '已中断';
        }
        tasks.set(t.id, t);
        n++;
    }
    return n;
}

let saveTimer = null;
function saveTasksNow() {
    try {
        const tmp = TASKS_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify([...tasks.values()], null, 2), 'utf8');
        fs.renameSync(tmp, TASKS_FILE);      // 先写临时文件再改名，避免写一半断电留下坏 json
    } catch (e) {
        console.warn('[任务] 落盘失败:', e.message);
    }
}
function saveTasks() {
    if (saveTimer) return;
    // 下载过程中 update() 每 800ms 调一次，这里做个防抖，别把磁盘刷爆
    saveTimer = setTimeout(() => { saveTimer = null; saveTasksNow(); }, 500);
    if (saveTimer.unref) saveTimer.unref();
}

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
    saveTasks();
    return task;
}

function update(task, patch) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    saveTasks();
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

/** 把成品文件名换成 OUT_DIR 内的绝对路径，非法名或越界返回空串 */
function fileOf(name) {
    const n = safeName(name);
    if (!n) return '';
    const full = path.join(OUT_DIR, n);
    return full.startsWith(OUT_DIR) ? full : '';
}

/**
 * 删除一条任务，顺带删掉它产出的 mp4。
 * 正在下载的任务不让删 —— 文件正被 ffmpeg 写着，删了会留下半截成品。
 */
function removeTask(id) {
    const task = tasks.get(String(id || ''));
    if (!task) return { ok: false, code: 404, error: '任务不存在或已过期' };
    if (task.status === 'queued' || task.status === 'running') {
        return { ok: false, code: 409, error: '任务正在下载中，暂时删不了，等它完成或失败后再删' };
    }

    let fileDeleted = false;
    let fileError = null;
    const full = fileOf(task.file);
    if (full && fs.existsSync(full)) {
        try {
            fs.unlinkSync(full);
            fileDeleted = true;
        } catch (e) {
            fileError = e.message;
        }
    }

    tasks.delete(task.id);
    saveTasksNow();
    return { ok: true, fileDeleted, fileError, task };
}

/**
 * 过期清理：任务记录和成品 mp4 一起删。
 * 另外兜底清两类残留 ——
 *   1. 磁盘上有、任务表里没有的孤儿 mp4（任务记录被清过 / 换了 tasks.json）
 *   2. 异常退出遗留的 tmp_* 临时工作目录
 */
function sweepExpired(reason) {
    const now = Date.now();
    let removedTasks = 0;
    let orphans = 0;
    let freed = 0;

    for (const [id, t] of tasks) {
        if (t.status === 'queued' || t.status === 'running') continue;   // 在跑的不动
        const born = Number(t.createdAt || t.updatedAt || 0);            // 「下载时间」
        if (!born || now - born < RETENTION_MS) continue;

        const full = fileOf(t.file);
        if (full && fs.existsSync(full)) {
            try {
                freed += fs.statSync(full).size;
                fs.unlinkSync(full);
            } catch { /* 文件被占用就下次再删 */ }
        }
        tasks.delete(id);
        removedTasks++;
    }

    const known = new Set([...tasks.values()].map((t) => t.file).filter(Boolean));
    try {
        for (const ent of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
            const nm = ent.name;
            const full = path.join(OUT_DIR, nm);

            if (ent.isDirectory()) {
                if (nm.startsWith('tmp_')) {
                    try {
                        if (now - fs.statSync(full).mtimeMs > TMP_MAX_AGE_MS) {
                            fs.rmSync(full, { recursive: true, force: true });
                        }
                    } catch { /* ignore */ }
                }
                continue;
            }
            if (!/\.mp4$/i.test(nm) || known.has(nm)) continue;

            try {
                const st = fs.statSync(full);
                if (now - st.mtimeMs < RETENTION_MS) continue;   // 还没到期
                fs.unlinkSync(full);
                freed += st.size;
                orphans++;
            } catch { /* ignore */ }
        }
    } catch { /* 目录读不了就算了 */ }

    if (removedTasks || orphans) {
        saveTasksNow();
        console.log(`[清理] ${reason}：删除 ${removedTasks} 条任务、${orphans} 个孤儿文件，`
            + `释放 ${(freed / 1048576).toFixed(1)} MB`);
    }
}

/**
 * 启动时把磁盘上「有文件、没任务记录」的 mp4 收编成任务条目。
 * 场景：老版本没落盘，或 tasks.json 被删过 —— 文件明明是好的，
 * 只是没人认领。不补的话这些录像在页面上就永远看不到下载入口了。
 * 「下载时间」取文件 mtime（≈ 写完的时刻），保留期按它算。
 */
function adoptOrphanFiles() {
    const known = new Set([...tasks.values()].map((t) => t.file).filter(Boolean));
    let adopted = 0;
    let entries;
    try {
        entries = fs.readdirSync(OUT_DIR, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const ent of entries) {
        if (!ent.isFile() || !/\.mp4$/i.test(ent.name)) continue;
        if (known.has(ent.name)) continue;

        const full = path.join(OUT_DIR, ent.name);
        let st;
        try { st = fs.statSync(full); } catch { continue; }

        // 已经过期的就别收录了，交给 sweepExpired 当孤儿文件删掉，
        // 免得日志里出现「刚收录又被清理」的迷惑记录
        if (Date.now() - st.mtimeMs >= RETENTION_MS) continue;

        const born = Math.round(st.mtimeMs);   // mtimeMs 是浮点，取整免得 json 里出现小数

        // 文件名形如 ch2_20261017_092000_102000.mp4，能反解出通道和时间段
        const m = /^ch(\d+)_(\d{4})(\d{2})(\d{2})_(\d{6})_(\d{6})\.mp4$/i.exec(ent.name);
        const params = m ? {
            channel: Number(m[1]),
            start: `${m[2]}-${m[3]}-${m[4]} ${m[5].slice(0, 2)}:${m[5].slice(2, 4)}:${m[5].slice(4, 6)}`,
            end: `${m[2]}-${m[3]}-${m[4]} ${m[6].slice(0, 2)}:${m[6].slice(2, 4)}:${m[6].slice(4, 6)}`,
        } : null;

        const id = crypto.randomUUID().slice(0, 8);
        tasks.set(id, {
            id,
            status: 'done',
            percent: 100,
            message: '历史文件（启动时自动收录）',
            file: ent.name,
            size: st.size,
            segments: 0,
            error: null,
            params,
            createdAt: born,
            updatedAt: born,
            adopted: true,
        });
        adopted++;
    }
    if (adopted) {
        saveTasksNow();
        console.log(`[任务] 收录了 ${adopted} 个磁盘上已有的成品文件`);
    }
    return adopted;
}

loadTasks();
adoptOrphanFiles();
sweepExpired('启动清理');
setInterval(() => sweepExpired('定时清理'), SWEEP_INTERVAL_MS).unref();

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

/**
 * 两个时间区间的交集，无交集返回 null。
 * 设备返回的「段」往往比用户要的区间长得多（常见一段 1~2 小时、1GB+），
 * 所以下载完要按用户实际要的范围裁掉多余部分。
 */
function overlap(aStart, aEnd, bStart, bEnd) {
    const s = Math.max(aStart.getTime(), bStart.getTime());
    const e = Math.min(aEnd.getTime(), bEnd.getTime());
    if (!(e > s)) return null;
    return { start: new Date(s), end: new Date(e) };
}

function toDate(s) {
    const d = new Date(String(s).replace(' ', 'T').replace(/Z?$/, 'Z'));
    return Number.isNaN(d.getTime()) ? null : d;
}

/** 秒数 -> "1 小时 23 分" */
function fmtDuration(sec) {
    if (!sec) return '0 秒';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h) return `${h} 小时 ${m} 分`;
    if (m) return `${m} 分 ${s} 秒`;
    return `${s} 秒`;
}

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
            const seg = segs[i];
            const stem = String(i).padStart(3, '0');
            const ps = path.join(work, `${stem}.ps`);

            // 只取用户真正要的那一段交集
            const segStart = toDate(seg.start);
            const segEnd = toDate(seg.end);
            let offsetSec = 0;
            let durSec = 0;
            if (segStart && segEnd) {
                const ov = overlap(segStart, segEnd, p.startUtc, p.endUtc);
                if (!ov) {
                    console.log(`[下载] 跳过第 ${i + 1} 段（与请求区间无交集）`);
                    continue;
                }
                offsetSec = (ov.start - segStart) / 1000;
                durSec = (ov.end - ov.start) / 1000;
            }

            update(task, { message: `下载第 ${i + 1}/${segs.length} 段` });

            const basePct = 5 + Math.round((i / segs.length) * 80);
            const spanPct = 80 / segs.length;

            // playbackURI 里带 size=整段总字节数，用它算真实百分比
            const sizeMatch = /[?&]size=(\d+)/.exec(seg.uri);
            const expectBytes = sizeMatch ? Number(sizeMatch[1]) : 0;

            // 设备只能从段头顺序吐数据，不能 seek。
            // 但用户常常只要一段末尾的几分钟 —— 拿到「偏移 + 时长」够用的字节数
            // 就没必要继续拉了，按线性码率估一个上限（留 25% + 8MB 余量防 VBR 偏差）。
            let maxBytes = 0;
            if (expectBytes && segStart && segEnd) {
                const segDur = (segEnd - segStart) / 1000;
                const needSec = offsetSec + durSec;
                if (segDur > 0 && needSec > 0 && needSec < segDur - 5) {
                    const bytesPerSec = expectBytes / segDur;
                    maxBytes = Math.round(needSec * bytesPerSec * 1.25 + 8 * 1048576);
                }
            }
            const planBytes = maxBytes || expectBytes;

            let lastTick = 0;
            let n = 0;
            try {
                n = await client.download(seg.uri, ps, (bytes) => {
                    const now = Date.now();
                    if (now - lastTick < 800) return;   // 别把进度刷爆
                    lastTick = now;
                    // 不知道总长时按 40MB 估，最多到 95%
                    const frac = planBytes
                        ? Math.min(1, bytes / planBytes)
                        : Math.min(0.95, bytes / (40 * 1024 * 1024));
                    update(task, {
                        percent: Math.min(88, basePct + Math.round(spanPct * frac)),
                        message: `下载第 ${i + 1}/${segs.length} 段 · `
                            + `${(bytes / 1048576).toFixed(1)}`
                            + (planBytes ? ` / ${(planBytes / 1048576).toFixed(0)} MB` : ' MB'),
                    });
                }, maxBytes);
            } catch (e) {
                console.warn(`[下载] 第 ${i + 1} 段失败: ${e.message}`);
            }

            if (n > 0) {
                update(task, { message: `转码第 ${i + 1}/${segs.length} 段` });
                const mp4 = path.join(work, `${stem}.mp4`);
                if (await ffmpeg.toMp4(ps, mp4, { offsetSec, durSec })) {
                    mp4s.push(mp4);
                } else {
                    console.warn(`[转码] 第 ${i + 1} 段转 mp4 失败`);
                }
            }
            try { fs.unlinkSync(ps); } catch { /* ignore */ }

            update(task, { percent: Math.min(90, basePct + Math.round(spanPct)) });
        }

        if (!mp4s.length) throw new Error('下载到的流为空，可能是该段录像不存在或已被覆盖');

        update(task, { message: '合并视频', percent: 94 });

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
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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
<tr><td>GET</td><td><code>/tasks</code></td><td>任务列表（含文件是否存在、到期时间）</td></tr>
<tr><td>DELETE</td><td><code>/task?id=</code></td><td>删除任务，连它的成品 mp4 一起删</td></tr>
<tr><td>POST</td><td><code>/deviceinfo</code></td><td>设备型号（自检）</td></tr>
<tr><td>POST</td><td><code>/storage</code></td><td>存储介质状态（自检，排查"没有录像"）</td></tr>
</table>
<p style="color:#666;font-size:13px">成品默认保留 <b>${RETENTION_DAYS}</b> 天（按发起下载的时间算），
到期后服务会自动删除任务记录和对应的 mp4；也可以随时用
<code>DELETE /task?id=</code> 手动删除。</p>
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
                retentionDays: RETENTION_DAYS,
                tasksFile: TASKS_FILE,
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
                const items = segs.map((s) => {
                    const a = toDate(s.start);
                    const b = toDate(s.end);
                    return {
                        start: s.start,
                        end: s.end,
                        seconds: (a && b) ? Math.max(0, Math.round((b - a) / 1000)) : null,
                    };
                });
                const totalSec = items.reduce((n, s) => n + (s.seconds || 0), 0);
                return json(res, {
                    success: true,
                    count: items.length,
                    totalSeconds: totalSec,
                    totalText: fmtDuration(totalSec),
                    segments: items,
                    hint: items.length ? undefined : '该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）',
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
            const list = [...tasks.values()]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((t) => {
                    const full = fileOf(t.file);
                    const born = Number(t.createdAt || t.updatedAt || 0);
                    return {
                        ...t,
                        // 磁盘上到底还有没有这个文件 —— 没有的话前端把「保存」置灰，
                        // 免得点下去拿到一个 404
                        fileExists: !!(full && fs.existsSync(full)),
                        expiresAt: born ? born + RETENTION_MS : null,
                    };
                });
            return json(res, {
                success: true,
                running,
                queued: queue.length,
                retentionDays: RETENTION_DAYS,
                tasks: list,
            });
        }

        // 删除任务（连它的成品 mp4 一起删）
        // DELETE /task?id=xxx 是标准用法；同时留一个 POST /task/delete 兜底，
        // 方便某些只能发 POST 的客户端。
        if ((req.method === 'DELETE' && (p === '/task' || p === '/tasks'))
            || (req.method === 'POST' && (p === '/task' || p === '/tasks' || p === '/task/delete'))) {
            let id = u.searchParams.get('id') || u.searchParams.get('taskId') || '';
            if (!id && req.method === 'POST') {
                try {
                    const b = await readJson(req);
                    id = b.id || b.taskId || '';
                } catch { /* 没 body 就当没传 */ }
            }
            const r = removeTask(id);
            if (!r.ok) return json(res, { success: false, error: r.error }, r.code);

            console.log(`[删除] 任务 ${id}${r.fileDeleted ? '，成品文件已删除' : '（无成品文件）'}`);
            return json(res, {
                success: true,
                taskId: id,
                file: r.task.file,
                fileDeleted: r.fileDeleted,
                fileError: r.fileError || undefined,
                remaining: tasks.size,
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
    console.log(`  保留策略 : ${RETENTION_DAYS} 天（按下载时间，到期自动删任务+文件）`);
    console.log(`  任务表   : ${TASKS_FILE}（已载入 ${tasks.size} 条）`);
    console.log('----------------------------------------');
    console.log('  接口:');
    console.log('    GET  /                    服务信息页');
    console.log('    GET  /health              健康检查');
    console.log('    POST /search              查录像段');
    console.log('    POST /download            发起下载');
    console.log('    GET  /progress?taskId=    查进度');
    console.log('    GET  /file?name=          取文件');
    console.log('    GET  /tasks               任务列表');
    console.log('    DELETE /task?id=          删除任务（连成品文件）');
    console.log('    POST /deviceinfo          设备型号（自检）');
    console.log('    POST /storage             存储状态（自检）');
    console.log('========================================');
});
