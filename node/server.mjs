/**
 * 海康录像下载 —— HTTP 服务（零依赖，Node 18+，用原生 node:http）
 *
 * 启动：
 *   node server.mjs --host 192.168.1.64 -u admin -p 你的密码 --port 8000
 *
 * 接口：
 *   GET  /api/records?channel=1&stream=main&start=2026-10-15 08:00:00&end=2026-10-15 09:00:00
 *        -> { ok:true, segments:[{start,end,uri}] }
 *   POST /api/download   {"channel":1,"stream":"main","start":"...","end":"..."}
 *        -> { ok:true, file:"ch1_xxx.mp4", size:12345678 }
 *   GET  /api/file?name=ch1_xxx.mp4
 *        -> mp4 文件流（Content-Disposition: attachment）
 *   GET  /api/health
 *
 * 换成 Express 也很简单：
 *   const app = express(); app.use(express.json())
 *   app.get('/api/records', async (req, res) => res.json(await svc.search(...)))
 *   app.post('/api/download', async (req, res) => res.json(await svc.download(...)))
 *   app.get('/api/file', (req, res) => res.download(join(OUTDIR, safeName(req.query.name))))
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { HikRecordService } from './hik-service.mjs'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

const { values: args } = parseArgs({
  options: {
    host: { type: 'string' },
    'nvr-port': { type: 'string', default: '80' },
    user: { type: 'string', short: 'u', default: 'admin' },
    password: { type: 'string', short: 'p' },
    tz: { type: 'string', default: '8' },
    port: { type: 'string', default: '8000' },
    outdir: { type: 'string', default: './hik_records' },
  },
})

if (!args.host || !args.password) {
  console.error('用法: node server.mjs --host 192.168.1.64 -u admin -p 密码 [--port 8000]')
  process.exit(1)
}

const OUTDIR = resolve(args.outdir)

const svc = new HikRecordService({
  host: args.host,
  port: Number(args['nvr-port']),
  user: args.user,
  password: args.password,
  tz: Number(args.tz),
  outDir: OUTDIR,
})

function json(res, obj, code = 200) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...CORS,
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function safeName(name) {
  const n = basename(String(name ?? ''))
  return /^[A-Za-z0-9_.-]+$/.test(n) ? n : ''
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS)
    res.end()
    return
  }

  try {
    // 查录像段
    if (req.method === 'GET' && url.pathname === '/api/records') {
      const q = url.searchParams
      const segs = await svc.search(
        q.get('channel') ?? 1,
        q.get('stream') ?? 'main',
        q.get('start'),
        q.get('end'),
      )
      return json(res, { ok: true, segments: segs })
    }

    // 下载并转码
    if (req.method === 'POST' && url.pathname === '/api/download') {
      const p = await readJson(req)
      const r = await svc.download(
        p.channel ?? 1, p.stream ?? 'main', p.start, p.end,
      )
      return json(res, { ok: true, file: r.name, size: r.size, segments: r.segments })
    }

    // 取成品文件
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const name = safeName(url.searchParams.get('name'))
      const file = join(OUTDIR, name)
      if (!name || !file.startsWith(OUTDIR) || !existsSync(file)) {
        return json(res, { ok: false, error: '文件不存在' }, 404)
      }
      const size = statSync(file).size
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': size,
        'Content-Disposition': `attachment; filename="${name}"`,
        ...CORS,
      })
      createReadStream(file).pipe(res)
      return
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, { ok: true, device: `http://${args.host}:${args['nvr-port']}` })
    }

    json(res, { ok: false, error: 'not found' }, 404)
  } catch (e) {
    json(res, { ok: false, error: e?.message ?? String(e) }, 500)
  }
})

const PORT = Number(args.port)
server.listen(PORT, '127.0.0.1', () => {
  console.log(`设备      : http://${args.host}:${args['nvr-port']}`)
  console.log(`服务地址  : http://127.0.0.1:${PORT}`)
  console.log(`成品目录  : ${OUTDIR}`)
  console.log('按 Ctrl+C 停止')
})
