/**
 * 录像下载业务编排：搜索 -> 逐段下载 -> 转 mp4 -> 合并
 *
 * 用法：
 *   import { HikRecordService } from './hik-service.mjs'
 *
 *   const svc = new HikRecordService({
 *     host: '192.168.1.64', user: 'admin', password: '密码',
 *     outDir: 'D:/hik_records',
 *   })
 *
 *   // 先看那段时间有没有录像
 *   const segs = await svc.search(1, 'main', '2026-10-15 08:00:00', '2026-10-15 09:00:00')
 *
 *   // 下载
 *   const r = await svc.download(1, 'main', '2026-10-15 08:00:00', '2026-10-15 09:00:00',
 *                                (pct) => console.log(pct + '%'))
 */
import { mkdir, mkdtemp, rm, unlink } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { HikIsapiClient } from './hik-client.mjs'
import { concat, pullRtsp, toMp4 } from './ffmpeg-runner.mjs'

/** 本地时间字符串 -> UTC Date。'2026-10-15 08:00:00' + tz8 -> 2026-10-15T00:00:00Z */
export function toUtcDate(localStr, tzHours = 8) {
  const s = String(localStr).trim().replace('T', ' ')
  const m = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!m) {
    throw new Error(`时间格式无法识别: ${localStr}（建议 "2026-10-15 08:00:00"）`)
  }
  const [, Y, M, D, h, mi, se = '00'] = m
  return new Date(Date.UTC(+Y, +M - 1, +D, +h, +mi, +se) - tzHours * 3600_000)
}

/** RTSP 时间格式：20261015T000000Z */
function rtspTime(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** 本地时间 -> 20261015_080000，用于文件名 */
function compact(s) {
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(s))
  if (!m) return 'unknown'
  return `${m[1]}${m[2]}${m[3]}_${m[4]}${m[5]}${m[6] ?? '00'}`
}

export class HikRecordService {
  constructor({ host, port = 80, user = 'admin', password = '', outDir, tz = 8 }) {
    this.host = host
    this.port = port
    this.user = user
    this.password = password
    this.outDir = outDir
    this.tz = tz
    this.client = new HikIsapiClient(host, port, user, password)
  }

  /** 通道号 + 码流 -> trackID。通道1主码流=101，子码流=102，通道2=201 */
  trackOf(channel, stream = 'main') {
    return Number(channel) * 100 + (String(stream).toLowerCase() === 'sub' ? 2 : 1)
  }

  /** 查询录像段。时间用本地时区，内部自动转 UTC */
  async search(channel, stream, startLocal, endLocal) {
    return this.client.search(
      this.trackOf(channel, stream),
      toUtcDate(startLocal, this.tz),
      toUtcDate(endLocal, this.tz),
    )
  }

  /**
   * 下载区间视频，返回 { path, name, size, segments }。
   * onProgress 收到 0-100，按已完成段数计算。
   */
  async download(channel, stream, startLocal, endLocal, onProgress) {
    const segs = await this.search(channel, stream, startLocal, endLocal)
    if (!segs.length) {
      throw new Error('该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）')
    }

    await mkdir(this.outDir, { recursive: true })
    const work = await mkdtemp(join(this.outDir, 'hikjob_'))
    const mp4s = []

    try {
      for (let i = 0; i < segs.length; i++) {
        const stem = String(i).padStart(3, '0')
        const ps = join(work, `${stem}.ps`)

        let n = 0
        try {
          n = await this.client.download(segs[i].uri, ps)
        } catch {
          n = 0
        }

        if (n > 0) {
          const mp4 = join(work, `${stem}.mp4`)
          if (await toMp4(ps, mp4)) mp4s.push(mp4)
        }
        try { await unlink(ps) } catch { /* ignore */ }

        onProgress?.(Math.round(((i + 1) / segs.length) * 100))
      }

      if (!mp4s.length) {
        throw new Error('下载到的流为空，可能是该段录像不存在或已被覆盖')
      }

      const name = `ch${channel}_${compact(startLocal)}_${compact(endLocal).slice(9)}.mp4`
      const finalFile = join(this.outDir, name)

      if (!(await concat(mp4s, finalFile))) {
        throw new Error('合并 mp4 失败')
      }

      return {
        path: finalFile,
        name,
        size: statSync(finalFile).size,
        segments: segs.length,
      }
    } finally {
      try { await rm(work, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }

  /**
   * 只下载原始 PS 流，不转码、不合并 —— 完全不需要 ffmpeg。
   * 返回 [{ name, path, size }]，每段一个文件。
   *
   * 注意：PS 是海康私有封装，VLC / 海康播放器能播，浏览器和剪辑软件播不了。
   * 要标准 mp4 还是得走 download()。
   */
  async downloadRaw(channel, stream, startLocal, endLocal, onProgress) {
    const segs = await this.search(channel, stream, startLocal, endLocal)
    if (!segs.length) {
      throw new Error('该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）')
    }

    await mkdir(this.outDir, { recursive: true })
    const out = []

    for (let i = 0; i < segs.length; i++) {
      const name = `ch${channel}_${compact(startLocal)}_${String(i + 1).padStart(2, '0')}.ps`
      const file = join(this.outDir, name)

      const n = await this.client.download(segs[i].uri, file)
      if (n > 0) out.push({ name, path: file, size: n })

      onProgress?.(Math.round(((i + 1) / segs.length) * 100))
    }
    return out
  }

  /**
   * 不走 ISAPI，直接让 ffmpeg 拉 RTSP 回放流。
   * 快、代码少，但**查不到那段时间有没有录像**，适合已知时间段稳定的场景。
   */
  async pullRtsp(channel, stream, startLocal, endLocal, onProgress) {
    const track = this.trackOf(channel, stream)
    const url = `rtsp://${encodeURIComponent(this.user)}:${encodeURIComponent(this.password)}`
      + `@${this.host}:554/Streaming/tracks/${track}`
      + `?starttime=${rtspTime(toUtcDate(startLocal, this.tz))}`
      + `&endtime=${rtspTime(toUtcDate(endLocal, this.tz))}`

    await mkdir(this.outDir, { recursive: true })
    const name = `ch${channel}_${compact(startLocal)}_${compact(endLocal).slice(9)}.mp4`
    const out = join(this.outDir, name)

    const done = await pullRtsp(url, out, (sec) => onProgress?.(sec))
    if (!done) throw new Error('ffmpeg 拉流失败：该时间段可能没有录像，或设备不支持 RTSP 回放')

    return { path: out, name, size: statSync(out).size }
  }
}
