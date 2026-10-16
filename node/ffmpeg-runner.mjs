/**
 * ffmpeg 调用封装（Node 版，用 child_process.spawn）
 *
 * 要点：
 *  - ffmpeg 是独立子进程，必须 await，别在请求处理里同步等
 *  - 部署环境要单独装 ffmpeg，或用 FFMPEG_PATH 环境变量指定绝对路径
 *  - ffmpeg 的进度信息打在 stderr 上（time=00:01:23.45），解析出来做进度
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg'

const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/

/** 跑一次 ffmpeg，返回退出码。-1 表示启动失败或超时 */
export function runFfmpeg(args, onSeconds) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(-1)
      return
    }

    let buf = ''
    const handle = (chunk) => {
      if (!onSeconds) return
      buf += chunk.toString('utf8')
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const m = TIME_RE.exec(line)
        if (m) {
          onSeconds(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]))
        }
      }
    }
    proc.stdout.on('data', handle)
    proc.stderr.on('data', handle)

    const timer = setTimeout(() => proc.kill('SIGKILL'), 30 * 60 * 1000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve(code ?? -1)
    })
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(-1)
    })
  })
}

const ok = (p) => existsSync(p) && statSync(p).size > 0

/** 海康 PS 流 -> mp4：先无损封装，不行再降级 */
export async function toMp4(input, output) {
  const attempts = [
    ['-c', 'copy', '-tag:v', 'hvc1'],
    ['-c:v', 'copy', '-c:a', 'aac'],
    ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac'],
  ]
  for (const extra of attempts) {
    const code = await runFfmpeg([
      '-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...extra, output,
    ])
    if (code === 0 && ok(output)) return true
  }
  return false
}

/** 多段合并成一条视频 */
export async function concat(parts, output) {
  if (!parts.length) return false

  if (parts.length === 1) {
    try {
      copyFileSync(parts[0], output)
      return ok(output)
    } catch {
      return false
    }
  }

  const listFile = `${output}.txt`
  try {
    const content = parts
      .map((p) => `file '${p.replace(/\\/g, '/')}'`)
      .join('\n')
    writeFileSync(listFile, content + '\n', 'utf8')
  } catch {
    return false
  }

  const code = await runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output,
  ])

  try { unlinkSync(listFile) } catch { /* ignore */ }

  return code === 0 && ok(output)
}

/**
 * 直接拉 RTSP 回放流存文件 —— 不走 ISAPI，一条命令搞定。
 * onSeconds 收到已处理的秒数。
 */
export async function pullRtsp(rtspUrl, output, onSeconds) {
  const code = await runFfmpeg([
    '-hide_banner', '-loglevel', 'info', '-y',
    '-rtsp_transport', 'tcp', '-i', rtspUrl,
    '-c', 'copy', '-tag:v', 'hvc1', output,
  ], onSeconds)
  return code === 0 && ok(output)
}

/** 探测 ffmpeg 是否可用 */
export async function ffmpegAvailable() {
  return (await runFfmpeg(['-version'])) === 0
}
