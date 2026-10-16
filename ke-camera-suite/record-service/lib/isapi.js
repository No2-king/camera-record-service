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
 */

const crypto = require('crypto');
const fs = require('fs');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const utcStamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * 本地时间字符串 -> UTC Date
 * '2026-10-15 08:00:00' + tz=8  ->  2026-10-15T00:00:00Z
 */
function toUtcDate(localStr, tzHours = 8) {
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

    /** 搜索录像段 */
    async search(track, startUtc, endUtc) {
        const out = [];
        const sid = crypto.randomUUID().replace(/-/g, '').toUpperCase();
        let pos = 0;

        for (;;) {
            const body = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${sid}</searchID>
  <trackList><trackID>${track}</trackID></trackList>
  <timeSpanList><timeSpan>
    <startTime>${utcStamp(startUtc)}</startTime>
    <endTime>${utcStamp(endUtc)}</endTime>
  </timeSpan></timeSpanList>
  <maxResults>100</maxResults>
  <searchResultPostion>${pos}</searchResultPostion>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`;

            const xml = await this.post('/ISAPI/ContentMgmt/search', body);
            const status = tag(xml, 'responseStatusStrg');
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

            if (String(status).toUpperCase() !== 'MORE') break;
            pos += Math.max(items.length, 1);
        }
        return out;
    }

    /** 下载一段录像为 PS 流，返回字节数 */
    async download(playbackUri, outPath) {
        const body = `<?xml version="1.0" encoding="utf-8"?>
<downloadRequest><playbackURI>${playbackUri.replace(/&/g, '&amp;')}</playbackURI></downloadRequest>`;

        const res = await this.request('POST', '/ISAPI/ContentMgmt/download', body);
        if (res.status !== 200) {
            throw new Error(`下载失败 HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        }
        if (!res.body) throw new Error('响应没有 body');

        let total = 0;
        const counter = new Transform({
            transform(chunk, _enc, cb) {
                total += chunk.length;
                cb(null, chunk);
            },
        });
        await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(outPath));
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

    async post(path, body, method = 'POST') {
        const res = await this.request(method, path, body);
        const xml = await res.text();
        if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${xml.slice(0, 300)}`);
        return xml;
    }

    async request(method, path, body) {
        const url = this.base + path;
        const headers = { 'Content-Type': 'application/xml' };

        let res = await this.send(url, method, headers, body);

        if (res.status === 401) {
            await res.body?.cancel();
            const challenge = res.headers.get('www-authenticate') || '';
            if (!challenge.toLowerCase().startsWith('digest')) {
                throw new Error(`设备要求非 Digest 认证，收到: ${challenge}`);
            }
            headers.Authorization = buildDigest(method, path, challenge, this.user, this.password);
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
        hint: '检查时间格式与时区：本服务按「本地时间」填写，内部自动转 UTC，tz 默认 8。',
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
