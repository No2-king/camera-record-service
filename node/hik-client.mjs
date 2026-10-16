/**
 * 海康 ISAPI 客户端（零依赖，Node 18+）
 *
 * 关键点：Node 的原生 fetch 和 JDK 的 HttpClient 一样，**不支持 Digest 认证**。
 * 所以这里同样手写了 Digest 握手：先发一次拿 401 + WWW-Authenticate，
 * 算出 response 摘要后带 Authorization 重发。
 *
 * 另一个好消息：Node 的 fetch（undici）默认**不读** http_proxy 环境变量，
 * 所以不会像 Python urllib 那样把局域网设备的请求甩给系统代理。
 * 但 Node 24+ 如果设了 NODE_USE_ENV_PROXY=1，就会走代理，记得别开。
 *
 * 用法：
 *   import { HikIsapiClient } from './hik-client.mjs'
 *   const c = new HikIsapiClient('192.168.1.64', 80, 'admin', '密码')
 *   const segs = await c.search(101, new Date(...), new Date(...))
 *   await c.download(segs[0].uri, './out.ps')
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const ISAPI_FMT = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')

export class HikIsapiClient {
  constructor(host, port = 80, user = 'admin', password = '') {
    this.base = `http://${host}:${port}`
    this.user = user
    this.password = password
  }

  /** 搜索录像段。track：通道N主码流 = N*100+1，子码流 = N*100+2 */
  async search(track, startUtc, endUtc) {
    const out = []
    const sid = randomUUID().replace(/-/g, '').toUpperCase()
    let pos = 0

    for (;;) {
      const body = `<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>${sid}</searchID>
  <trackList><trackID>${track}</trackID></trackList>
  <timeSpanList><timeSpan>
    <startTime>${ISAPI_FMT(startUtc)}</startTime>
    <endTime>${ISAPI_FMT(endUtc)}</endTime>
  </timeSpan></timeSpanList>
  <maxResults>100</maxResults>
  <searchResultPostion>${pos}</searchResultPostion>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>`

      const xml = await this.post('/ISAPI/ContentMgmt/search', body)
      const status = tag(xml, 'responseStatusStrg')
      const items = blocks(xml, 'searchMatchItem')

      for (const it of items) {
        const uri = unescapeXml(tag(it, 'playbackURI'))
        if (!uri) continue
        const scope = blocks(it, 'timeSpan')[0] ?? it
        out.push({
          start: tag(scope, 'startTime'),
          end: tag(scope, 'endTime'),
          uri,
        })
      }

      if (String(status).toUpperCase() !== 'MORE') break
      pos += Math.max(items.length, 1)
    }
    return out
  }

  /** 下载一段录像为海康私有 PS 流，返回字节数（流式写盘，不占内存） */
  async download(playbackUri, outPath) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<downloadRequest><playbackURI>${playbackUri.replace(/&/g, '&amp;')}</playbackURI></downloadRequest>`

    const res = await this.request('POST', '/ISAPI/ContentMgmt/download', body)
    if (res.status !== 200) {
      throw new Error(`下载失败 HTTP ${res.status}: ${await res.text()}`)
    }
    if (!res.body) throw new Error('响应没有 body')

    let total = 0
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        total += chunk.length
        cb(null, chunk)
      },
    })

    await pipeline(Readable.fromWeb(res.body), counter, createWriteStream(outPath))
    return total
  }

  async post(path, body) {
    const res = await this.request('POST', path, body)
    const xml = await res.text()
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${xml}`)
    return xml
  }

  // -------------------------------------------------------- Digest 核心

  async request(method, path, body) {
    const url = this.base + path
    const headers = { 'Content-Type': 'application/xml' }

    let res = await this.send(url, method, headers, body)

    if (res.status === 401) {
      await res.body?.cancel()
      const challenge = res.headers.get('www-authenticate') || ''
      if (!challenge.toLowerCase().startsWith('digest')) {
        throw new Error(`设备要求非 Digest 认证，收到: ${challenge}`)
      }
      headers.Authorization = buildDigest(method, path, challenge, this.user, this.password)
      res = await this.send(url, method, headers, body)
    }
    return res
  }

  /** 包一层，把 undici 那句没头没尾的 "fetch failed" 换成能排查的报错 */
  async send(url, method, headers, body) {
    try {
      return await fetch(url, { method, headers, body })
    } catch (e) {
      const detail = e?.cause?.code ?? e?.cause?.message ?? e?.message ?? 'unknown'
      throw new Error(`无法连接设备 ${this.base} — ${detail}`)
    }
  }
}

export function md5(s) {
  return createHash('md5').update(s, 'utf8').digest('hex')
}

export function parseChallenge(challenge) {
  const map = {}
  const s = challenge.replace(/^Digest\s+/i, '')
  const re = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*([^,\s]+)/g
  let m
  while ((m = re.exec(s)) !== null) {
    if (m[1] !== undefined) map[m[1].toLowerCase()] = m[2]
    else map[m[3].toLowerCase()] = m[4]
  }
  return map
}

export function buildDigest(method, uriPath, challenge, user, password) {
  const p = parseChallenge(challenge)
  let qop = p.qop || ''
  if (qop.includes(',')) qop = qop.split(',')[0].trim()

  const nc = '00000001'
  const cnonce = randomBytes(8).toString('hex')
  const ha1 = md5(`${user}:${p.realm}:${password}`)
  const ha2 = md5(`${method}:${uriPath}`)
  const response = qop
    ? md5(`${ha1}:${p.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${p.nonce}:${ha2}`)

  let out = `Digest username="${user}", realm="${p.realm}", nonce="${p.nonce}", `
    + `uri="${uriPath}", algorithm=MD5`
  if (qop) out += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`
  out += `, response="${response}"`
  return out
}

// -------------------------------------------------------- XML 小工具

function tag(xml, name) {
  if (!xml) return null
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml)
  return m ? m[1].trim() : null
}

function blocks(xml, name) {
  if (!xml) return []
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'g')
  const out = []
  let m
  while ((m = re.exec(xml)) !== null) out.push(m[1])
  return out
}

function unescapeXml(s) {
  if (!s) return s
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}
