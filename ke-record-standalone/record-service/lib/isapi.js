'use strict';
/**
 * 海康 ISAPI 客户端
 *
 * 做两件事：
 *   1. 搜索某时间段有没有录像   POST /ISAPI/ContentMgmt/search
 *   2. 下载该段录像为 PS 流      POST /ISAPI/ContentMgmt/download
 *
 * 注意：Node 的 fetch 不支持 Digest 认证，这里手写了握手流程。
 *      鉴权方式是 HTTP Digest，不是 Basic。
 *
 * ── 两个踩过的坑（改之前务必读一下）────────────────────────────
 *
 * ① searchID 必须是「带连字符的 UUID」
 *    crypto.randomUUID() 出来是 8-4-4-4-12 带连字符的，直接用。
 *    千万不要 .replace(/-/g,'') 去掉连字符 —— 设备解析器会拒绝整个 body，
 *    返回 HTTP 400 badXmlContent，并附一句毫无意义的
 *    "Tag N is invalid (two root tags)"。
 *    这个报错和 XML 结构、元素顺序、编码、填充长度全都无关，
 *    唯一变量就是 searchID 的格式。实测：
 *      searchID=A15D9C3E-13BE-4A45-B660-857C39B33530  -> 200 OK
 *      searchID=A15D9C3E13BE4A45B660857C39B33530      -> 400
 *    （参照物：设备自带 Web UI 的 doc/script/playback/search.js
 *      里就是 new UUID 直接拼进 XML。）
 *
 * ② download 返回的是「IMKH 私有头 + 标准 MPEG-PS」
 *    响应 Content-Type 是 Opaque/data，前 40 字节是 49 4d 4b 48（"IMKH"），
 *    之后从 00 00 01 BA 开始才是标准 PS 流。不剥掉这层头，
 *    ffmpeg 认不出来。下面用 stripHikHeader() 自动定位 PS 起点。
 *
 * 另外：trackID 只有 101/201/301/401 这些主码流轨道存在。
 *      子码流（102/202…）没配录像时会返回 400，search() 会自动回退到主码流。
 */

const crypto = require('crypto');
const fs = require('fs');

const utcStamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** XML 文本转义（playbackURI 里带 & 参数，必须转义） */
function escapeXml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * 剥掉海康下载流前面的 IMKH 私有头，从标准 PS 同步字 00 00 01 BA 开始。
 * 找不到（本来就是纯 PS）就原样放行，不丢数据。
 * 返回 { buf, started }：started 为 true 表示已经定位到 PS 起点。
 */
const PS_MARK = Buffer.from([0x00, 0x00, 0x01, 0xba]);
const HEAD_MAX = 1024 * 1024;

function stripHikHeader(pending) {
    const i = pending.indexOf(PS_MARK);
    if (i >= 0) return { buf: pending.subarray(i), started: true };
    if (pending.length > HEAD_MAX) return { buf: pending, started: true };
    return { buf: Buffer.alloc(0), started: false };
}

/**
 * 本地时间字符串 -> 发给设备的 Date
 * tzHours = 0（默认）时不换算：'2026-10-15 20:00:00' -> 2026-10-15T20:00:00Z
 * tzHours = 8 时会减 8 小时：  '2026-10-15 20:00:00' -> 2026-10-15T12:00:00Z
 */
function toUtcDate(localStr, tzHours = 0) {
    const s = String(localStr).trim().replace('T', ' ');
    const m = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) throw new Error(`时间格式无法识别: ${localStr}（应为 "2026-10-15 08:00:00"）`);
    const [, Y, M, D, h, mi, se = '00'] = m;
    return new Date(Date.UTC(+Y, +M - 1, +D, +h, +mi, +se) - tzHours * 3600 * 1000);
}

/** 通道号 + 码流 -> trackID。通道1主码流=101，子码流=102，通道2=201 */
function trackId(channel, stream = 'main') {
    return Number(channel) * 100 + (String(stream).toLowerCase() === 'sub' ? 2 : 1);
}

// ------------------------------------------------------------------ Digest

function md5(s) {
    return crypto.createHash('md5').update(s, 'utf8').digest('hex');
}

function parseChallenge(challenge) {
    const map = {};
    const s = String(challenge).replace(/^Digest\s+/i, '');
    const re = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*([^,\s]+)/g;
    let m;
    while ((m = re.exec(s)) !== null) {
        if (m[1] !== undefined) map[m[1].toLowerCase()] = m[2];
        else map[m[3].toLowerCase()] = m[4];
    }
    return map;
}

function buildDigest(method, uriPath, challenge, user, password) {
    const p = parseChallenge(challenge);
    let qop = p.qop || '';
    if (qop.includes(',')) qop = qop.split(',')[0].trim();

    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const ha1 = md5(`${user}:${p.realm}:${password}`);
    const ha2 = md5(`${method}:${uriPath}`);
    const response = qop
        ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
        : md5(`${ha1}:${p.nonce}:${ha2}`);

    let out = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", `
        + `uri="${uriPath}", algorithm=MD5`;
    if (qop) out += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
    out += `, response="${response}"`;
    return out;
}

// ------------------------------------------------------------------ 主体

class HikIsapiClient {
    /**
     * @param {string} host  设备 IP
     * @param {number} port  ISAPI(HTTP) 端口，海康通常是 80（注意不是 ONVIF 的 9080）
     */
    constructor(host, port = 80, user = 'admin', password = '') {
        this.base = `http://${host}:${port}`;
        this.user = user;
        this.password = password;
        this.challenge = null;   // 缓存 Digest challenge，见 ensureAuth()
    }

    /** 查设备信息，用来确认品牌/型号 */
    async deviceInfo() {
        const xml = await this.post('/ISAPI/System/deviceInfo', null, 'GET');
        return {
            name: tag(xml, 'deviceName'),
            model: tag(xml, 'model'),
            serial: tag(xml, 'serialNumber'),
            firmware: tag(xml, 'firmwareVersion'),
        };
    }

    /**
     * 搜索录像段
     *
     * @param {number} track     trackID（通道1主码流=101）
     * @param {Date}   startUtc  起始时间（UTC）
     * @param {Date}   endUtc    结束时间（UTC）
     * @returns {Promise<Array<{start:string,end:string,uri:string}>>}
     */
    async search(track, startUtc, endUtc) {
        try {
            return await this._search(track, startUtc, endUtc);
        } catch (e) {
            // 子码流没配录像时设备返回 400，自动回退到主码流再试一次
            const sub = Number(track) % 100 === 2;
            if (sub && /HTTP 400/.test(e.message)) {
                return this._search(Number(track) - 1, startUtc, endUtc);
            }
            throw e;
        }
    }

    async _search(track, startUtc, endUtc) {
        const out = [];
        // ① 必须带连字符，见文件头注释
        const sid = crypto.randomUUID().toUpperCase();
        let pos = 0;

        for (;;) {
            // 整个 body 必须拼成一行，不要换行/缩进
            const body = "<?xml version='1.0' encoding='utf-8'?>"
                + '<CMSearchDescription>'
                + `<searchID>${sid}</searchID>`
                + `<trackList><trackID>${track}</trackID></trackList>`
                + '<timeSpanList><timeSpan>'
                + `<startTime>${utcStamp(startUtc)}</startTime>`
                + `<endTime>${utcStamp(endUtc)}</endTime>`
                + '</timeSpan></timeSpanList>'
                + '<maxResults>100</maxResults>'
                + `<searchResultPostion>${pos}</searchResultPostion>`
                + '<metadataList>'
                + '<metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>'
                + '</metadataList>'
                + '</CMSearchDescription>';

            const xml = await this.post('/ISAPI/ContentMgmt/search', body);
            const status = (tag(xml, 'responseStatusStrg') || '').toUpperCase();
            const items = blocks(xml, 'searchMatchItem');

            for (const it of items) {
                const uri = unescapeXml(tag(it, 'playbackURI'));
                if (!uri) continue;
                const scope = blocks(it, 'timeSpan')[0] || it;
                out.push({
                    start: tag(scope, 'startTime'),
                    end: tag(scope, 'endTime'),
                    uri,
                });
            }

            // MORE 表示还有下一页，searchResultPostion 传已收到的条数
            if (status !== 'MORE' || items.length === 0) break;
            pos += items.length;
            if (pos > 5000) break; // 防御：别无限翻页
        }
        return out;
    }

    /**
     * 下载一段录像。设备返回 IMKH 私有头 + MPEG-PS，
     * 这里会把头剥掉再落盘，产出的是 ffmpeg 能直接读的纯 PS 文件。
     *
     * @param {string} playbackUri  search() 返回的 uri
     * @param {string} outPath      落盘路径
     * @param {(bytes:number)=>void} [onBytes] 进度回调
     * @param {number} [maxBytes]   收到这么多字节就主动掐断（0 = 不限）
     *                              设备是按整段文件吐的，不能 seek；
     *                              但用户往往只要这段末尾的几分钟，
     *                              拿到够用的数据后继续拉纯属浪费带宽。
     * @returns {Promise<number>}   写入的字节数
     */
    async download(playbackUri, outPath, onBytes, maxBytes = 0) {
        const body = "<?xml version='1.0' encoding='utf-8'?>"
            + `<downloadRequest><playbackURI>${escapeXml(playbackUri)}</playbackURI></downloadRequest>`;

        const res = await this.request('POST', '/ISAPI/ContentMgmt/download', body);
        if (res.status !== 200) {
            const text = await res.text().catch(() => '');
            throw new Error(`下载失败 HTTP ${res.status}: ${text.slice(0, 300)}`);
        }
        if (!res.body) throw new Error('下载响应没有 body');

        const reader = res.body.getReader();
        const out = fs.createWriteStream(outPath);
        let pending = Buffer.alloc(0);
        let started = false;
        let total = 0;

        const write = async (buf) => {
            if (!buf.length) return;
            total += buf.length;
            if (onBytes) {
                try { onBytes(total); } catch { /* 进度回调异常不影响下载 */ }
            }
            if (!out.write(buf)) {
                await new Promise((r) => out.once('drain', r));
            }
        };

        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;

                let buf = Buffer.from(value);
                if (!started) {
                    pending = Buffer.concat([pending, buf]);
                    const r = stripHikHeader(pending);
                    if (!r.started) continue;          // 头还没读完，继续攒
                    started = true;
                    buf = r.buf;
                    pending = Buffer.alloc(0);
                }

                await write(buf);

                // 已经拿到需要的量，剩下的不用拉了
                if (maxBytes > 0 && total >= maxBytes) {
                    try { await reader.cancel(); } catch { /* ignore */ }
                    break;
                }
            }
            // 流结束时头还没定位到（极短流），原样写出别丢数据
            if (!started && pending.length) await write(pending);
        } finally {
            await new Promise((r) => out.end(r));
        }

        return total;
    }

    /**
     * 查询设备的存储介质状态（SD 卡 / 硬盘 / NAS）。
     * 用来回答那个最关键的问题：**这台设备到底有没有地方存录像**。
     */
    async storage() {
        const xml = await this.post('/ISAPI/ContentMgmt/Storage', null, 'GET');
        const volumes = [];
        for (const kind of ['hdd', 'sdCard', 'nas', 'volume']) {
            for (const blk of blocks(xml, kind)) {
                volumes.push({
                    type: kind,
                    id: tag(blk, 'id'),
                    name: tag(blk, 'name'),
                    status: tag(blk, 'status'),
                    capacity: toNum(tag(blk, 'capacity')),
                    freeSpace: toNum(tag(blk, 'freeSpace')),
                });
            }
        }
        return volumes;
    }

    /**
     * 预认证：先发一个轻量 GET 把 Digest challenge 拿到手并缓存。
     *
     * 为什么不直接「先发目标请求、收到 401 再带 body 重发」：
     * 那样 POST 的 body 会被上传两次，设备端行为不确定。
     * 这里改成一次 GET 换 challenge，之后所有请求都是单次带认证发出。
     */
    async ensureAuth() {
        if (this.challenge) return;
        const res = await this.send(this.base + '/ISAPI/System/deviceInfo', 'GET', {}, undefined);
        await res.body?.cancel().catch(() => {});
        if (res.status === 401) {
            const ch = res.headers.get('www-authenticate') || '';
            if (!ch.toLowerCase().startsWith('digest')) {
                throw new Error(`设备要求非 Digest 认证，收到: ${ch}`);
            }
            this.challenge = ch;
        }
        // 设备允许匿名访问（200）时 challenge 保持为空，后续请求不带 Authorization
    }

    async post(path, body, method = 'POST') {
        const res = await this.request(method, path, body);
        const xml = await res.text();
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${xml.slice(0, 300)}`);
        return xml;
    }

    async request(method, path, body) {
        await this.ensureAuth();

        const url = this.base + path;
        const headers = { 'Content-Type': 'application/xml' };
        if (this.challenge) {
            headers.Authorization = buildDigest(method, path, this.challenge, this.user, this.password);
        }

        let res = await this.send(url, method, headers, body);

        // nonce 过期 / 认证失效：重新握手一次再试
        if (res.status === 401) {
            await res.body?.cancel().catch(() => {});
            this.challenge = null;
            await this.ensureAuth();
            if (this.challenge) {
                headers.Authorization = buildDigest(method, path, this.challenge, this.user, this.password);
            }
            res = await this.send(url, method, headers, body);
        }
        return res;
    }

    async send(url, method, headers, body) {
        try {
            return await fetch(url, { method, headers, body: body || undefined });
        } catch (e) {
            const detail = e?.cause?.code || e?.cause?.message || e?.message || 'unknown';
            throw new Error(`无法连接设备 ${this.base} — ${detail}`);
        }
    }
}

// ------------------------------------------------------------------ XML 工具

function tag(xml, name) {
    if (!xml) return null;
    const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
    return m ? m[1].trim() : null;
}

function blocks(xml, name) {
    if (!xml) return [];
    const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'g');
    const out = [];
    let m;
    while ((m = re.exec(xml)) !== null) out.push(m[1]);
    return out;
}

function unescapeXml(s) {
    if (!s) return s;
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function toNum(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ 错误码翻译

/**
 * 海康 ISAPI 的 subStatusCode -> 人话 + 排查建议
 *
 * 设备返回的 XML 形如：
 *   <ResponseStatus>
 *     <statusCode>4</statusCode>
 *     <statusString>Invalid Operation</statusString>
 *     <subStatusCode>invalidMemoryCardOrNAS</subStatusCode>
 *   </ResponseStatus>
 */
const ISAPI_ERRORS = {
    invalidMemoryCardOrNAS: {
        text: '设备没有可用的录像存储（内存卡 / NAS 均无效）',
        hint: '① 录像是不是存在 NVR 上？如果是，把 cameraIp 改成 NVR 的 IP 再试'
            + '（摄像头本体一般不存录像，只有插了 SD 卡才存）；'
            + '② 摄像头有卡槽但没插卡 → 插卡并在设备网页里格式化；'
            + '③ 插了卡但未初始化或卡已损坏；'
            + '④ 设备本身是无存储型号。'
            + '可调 POST /storage 查看设备报告的存储介质状态。',
    },
    noRecord: {
        text: '该时间段确实没有录像',
        hint: '录像计划没覆盖这个时间段 / 硬盘已循环覆盖 / 时间或时区填错。',
    },
    notFound: {
        text: '设备找不到对应资源',
        hint: '检查通道号 channel 和码流 stream；设备上不存在的通道，trackID 会无效。',
    },
    invalidTrackID: {
        text: '通道号 / trackID 无效',
        hint: '确认设备实际有几个通道。通道1主码流=101、子码流=102，通道2=201。',
    },
    badParameters: {
        text: '请求参数不被设备接受',
        hint: '检查时间格式：本服务默认按「设备本地时间」原样发送，不做时区换算（tz 默认 0）。',
    },
    badAuthorization: {
        text: '认证失败',
        hint: '用户名或密码错误；也可能是设备强制要求修改弱密码。',
    },
    riskPassword: {
        text: '设备要求修改密码（检测到弱密码）',
        hint: '登录设备网页按提示改掉弱密码后重试。',
    },
    deviceBusy: {
        text: '设备忙',
        hint: '同时下载的任务太多，或设备正在处理其它重负载操作，稍后重试。',
    },
    notSupport: {
        text: '设备不支持该操作',
        hint: '这台设备可能不是海康，或固件过旧不支持 ISAPI 录像检索。'
            + '可调 POST /deviceinfo 看设备型号。',
    },
    badXmlContent: {
        text: '设备拒绝了检索请求（返回 badXmlContent）',
        hint: '① 最常见原因是 searchID 不是「带连字符的 UUID」——'
            + '本服务已按设备 Web UI 的格式生成，若仍报此错，'
            + '说明固件更特殊，可调 POST /deviceinfo 确认型号与固件版本；'
            + '② 也可能是该通道/码流根本没有录像轨道（子码流常见），'
            + '试试把 stream 改成 main；'
            + '③ 设备返回的 "Tag N is invalid (two root tags)" 是固件固定附带的'
            + '误导性诊断，与 XML 结构无关，不要按它去改 XML。',
    },
};

/**
 * 把设备返回的原始错误串翻译成人话；识别不出来就原样返回，不丢信息。
 */
function explainIsapiError(message) {
    const s = String(message || '');
    for (const [code, info] of Object.entries(ISAPI_ERRORS)) {
        if (s.includes(code)) {
            return `${info.text}　【设备返回: ${code}】\n排查建议：${info.hint}`;
        }
    }
    return s;
}

module.exports = {
    HikIsapiClient, toUtcDate, trackId, md5, parseChallenge, buildDigest,
    explainIsapiError, ISAPI_ERRORS,
};
