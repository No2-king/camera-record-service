#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
海康 NVR / DVR 历史录像下载工具（ISAPI，纯标准库，无需 pip 安装）

原理：先调 /ISAPI/ContentMgmt/search 搜索录像段，拿到 playbackURI，
      再调 /ISAPI/ContentMgmt/download 把该段流下载为 .ps，
      最后用 ffmpeg 无损封装成 .mp4。

用法示例：
  python hik_download.py --host 192.168.1.64 -u admin -p 你的密码 \
      --channel 1 --start "2026-10-15 08:00:00" --end "2026-10-15 09:00:00"

只搜索不下载（先看看那段时间到底有没有录像）：
  python hik_download.py --host 192.168.1.64 -u admin -p 密码 \
      --channel 1 --start "2026-10-15 08:00:00" --end "2026-10-15 09:00:00" --list-only
"""

import argparse
import os
import subprocess
import sys
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from urllib.request import (
    HTTPDigestAuthHandler,
    HTTPPasswordMgrWithDefaultRealm,
    ProxyHandler,
    Request,
    build_opener,
)

# ---------------------------------------------------------------- 时间处理
# 关键坑：ISAPI 搜索用 ISO 格式 2026-10-15T00:00:00Z
#         RTSP/Streaming 用紧凑格式 20261015T000000Z
#         两者都是 UTC，输入按本地时区换算

def parse_local(s, tz_hours):
    """把本地时间字符串解析成带时区的 datetime。"""
    s = s.strip().replace('/', '-').replace('T', ' ')
    for fmt in ('%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y-%m-%d'):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.replace(tzinfo=timezone(timedelta(hours=tz_hours)))
        except ValueError:
            continue
    raise ValueError(f'时间格式无法识别: {s!r}（建议 "2026-10-15 08:00:00"）')


def fmt_isapi(dt_utc):
    """2026-10-15T00:00:00Z —— 用于 search 请求体。"""
    return dt_utc.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


# ---------------------------------------------------------------- XML 工具
def strip_ns(tag):
    return tag.split('}', 1)[1] if '}' in tag else tag


def find_all(root, name):
    return [e for e in root.iter() if strip_ns(e.tag) == name]


def find_text(node, name):
    for e in node.iter():
        if strip_ns(e.tag) == name:
            return (e.text or '').strip()
    return None


# ---------------------------------------------------------------- 认证
def make_opener(base, user, password):
    """海康用 HTTP Digest 认证，不是 Basic。

    注意：必须显式挂一个空的 ProxyHandler，强制不走系统 HTTP 代理。
    否则在配了代理的机器上（http_proxy 环境变量），连局域网 NVR 的请求
    会被甩给代理，结果是 502 Bad Gateway 而不是连不上设备。
    """
    pwmgr = HTTPPasswordMgrWithDefaultRealm()
    pwmgr.add_password(None, base, user, password)
    return build_opener(ProxyHandler({}), HTTPDigestAuthHandler(pwmgr))


# ---------------------------------------------------------------- 搜索录像
SEARCH_TPL = """<?xml version="1.0" encoding="utf-8"?>
<CMSearchDescription>
  <searchID>{sid}</searchID>
  <trackList>
    <trackID>{track}</trackID>
  </trackList>
  <timeSpanList>
    <timeSpan>
      <startTime>{start}</startTime>
      <endTime>{end}</endTime>
    </timeSpan>
  </timeSpanList>
  <maxResults>100</maxResults>
  <searchResultPostion>{pos}</searchResultPostion>
  <metadataList>
    <metadataDescriptor>//recordType.meta.std-cgi.com</metadataDescriptor>
  </metadataList>
</CMSearchDescription>"""


def search_segments(opener, base, track, start_utc, end_utc, verbose=True):
    """分页搜索录像段，返回 [{start, end, uri}, ...]"""
    sid = uuid.uuid4().hex.upper()
    out, pos = [], 0
    while True:
        body = SEARCH_TPL.format(
            sid=sid, track=track,
            start=fmt_isapi(start_utc), end=fmt_isapi(end_utc), pos=pos,
        )
        req = Request(base + '/ISAPI/ContentMgmt/search',
                      data=body.encode('utf-8'),
                      headers={'Content-Type': 'application/xml'})
        with opener.open(req, timeout=30) as resp:
            xml = resp.read().decode('utf-8', 'ignore')

        root = ET.fromstring(xml)
        status = find_text(root, 'responseStatusStrg') or ''
        matches = find_all(root, 'searchMatchItem')

        if verbose:
            print(f'  [search] 状态={status or "?"} 本次返回 {len(matches)} 段')

        for m in matches:
            ts = find_all(m, 'timeSpan')
            item = {
                'start': find_text(ts[0], 'startTime') if ts else None,
                'end': find_text(ts[0], 'endTime') if ts else None,
                'uri': find_text(m, 'playbackURI'),
            }
            if item['uri']:
                out.append(item)

        if status.upper() == 'MORE':
            pos += len(matches) or 1
            continue
        break
    return out


# ---------------------------------------------------------------- 下载一段
def download_segment(opener, base, playback_uri, out_path):
    # XML 里 & 必须转义成 &amp;
    esc = playback_uri.replace('&', '&amp;')
    body = ('<?xml version="1.0" encoding="utf-8"?>'
            '<downloadRequest>'
            f'<playbackURI>{esc}</playbackURI>'
            '</downloadRequest>')
    req = Request(base + '/ISAPI/ContentMgmt/download',
                  data=body.encode('utf-8'),
                  headers={'Content-Type': 'application/xml'})

    total = 0
    with opener.open(req, timeout=120) as resp, open(out_path, 'wb') as f:
        while True:
            chunk = resp.read(256 * 1024)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
            if total % (10 * 1024 * 1024) < 256 * 1024:
                print(f'    已下载 {total / 1048576:.1f} MB', end='\r')
    print(f'    已下载 {total / 1048576:.1f} MB      ')
    return total


# ---------------------------------------------------------------- 转 mp4
def convert_to_mp4(ps_path, mp4_path):
    base = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', ps_path]
    attempts = [
        base + ['-c', 'copy', '-tag:v', 'hvc1', mp4_path],          # 无损封装
        base + ['-c:v', 'copy', '-c:a', 'aac', mp4_path],           # 只转音频
        base + ['-c:v', 'libx264', '-preset', 'veryfast',
                '-crf', '23', '-c:a', 'aac', mp4_path],             # 全转码兜底
    ]
    for cmd in attempts:
        try:
            r = subprocess.run(cmd, capture_output=True)
        except FileNotFoundError:
            return False, 'ffmpeg 未找到'
        if r.returncode == 0 and os.path.exists(mp4_path) and os.path.getsize(mp4_path) > 0:
            return True, 'ok'
    return False, (r.stderr or b'').decode('utf-8', 'ignore')[-300:]


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description='海康 NVR 历史录像下载（ISAPI）')
    ap.add_argument('--host', required=True, help='NVR 的 IP，如 192.168.1.64')
    ap.add_argument('--port', type=int, default=80, help='HTTP 端口，默认 80')
    ap.add_argument('-u', '--user', default='admin', help='用户名，默认 admin')
    ap.add_argument('-p', '--password', required=True, help='密码')
    ap.add_argument('--channel', type=int, default=1, help='通道号，从 1 开始')
    ap.add_argument('--stream', choices=['main', 'sub'], default='main',
                    help='主码流/子码流，默认 main')
    ap.add_argument('--start', required=True, help='开始时间（本地时间）')
    ap.add_argument('--end', required=True, help='结束时间（本地时间）')
    ap.add_argument('--tz', type=float, default=8, help='输入时间的时区，默认 8（北京）')
    ap.add_argument('--out', default='./downloads', help='输出目录')
    ap.add_argument('--list-only', action='store_true', help='只搜索，不下载')
    ap.add_argument('--no-mp4', action='store_true', help='不转 mp4，保留原始 .ps')
    args = ap.parse_args()

    base = f'http://{args.host}:{args.port}'
    track = args.channel * 100 + (1 if args.stream == 'main' else 2)

    start_utc = parse_local(args.start, args.tz)
    end_utc = parse_local(args.end, args.tz)

    print(f'设备     : {base}')
    print(f'通道/流  : {args.channel} / {args.stream}  (trackID={track})')
    print(f'本地时间 : {args.start}  →  {args.end}   (UTC+{args.tz:g})')
    print(f'UTC 时间 : {fmt_isapi(start_utc)}  →  {fmt_isapi(end_utc)}')
    print()

    opener = make_opener(base, args.user, args.password)

    print('① 搜索录像段 ...')
    try:
        segs = search_segments(opener, base, track, start_utc, end_utc)
    except Exception as e:
        print(f'  搜索失败: {e}')
        print('  排查：密码/用户是否正确（Digest 认证）；HTTP 端口是否为 80；'
              '该通道是否配置了录像计划。')
        return 1

    if not segs:
        print('  该时间段没有录像。可能原因：未配置录像计划 / 已被循环覆盖 / 时间写错了。')
        return 2

    print(f'  共找到 {len(segs)} 段录像：')
    for i, s in enumerate(segs, 1):
        print(f'    {i:>3}. {s["start"]} → {s["end"]}')
        print(f'         {s["uri"]}')

    if args.list_only:
        return 0

    os.makedirs(args.out, exist_ok=True)
    print('\n② 开始下载 ...')
    ok = 0
    for i, s in enumerate(segs, 1):
        stamp = (s['start'] or 'seg').replace(':', '').replace('-', '').replace('T', '_').replace('Z', '')
        ps_path = os.path.join(args.out, f'ch{args.channel}_{stamp}.ps')
        print(f'  [{i}/{len(segs)}] {os.path.basename(ps_path)}')
        try:
            size = download_segment(opener, base, s['uri'], ps_path)
        except Exception as e:
            print(f'    下载失败: {e}')
            continue
        if size == 0:
            print('    下载为空，跳过')
            continue

        if args.no_mp4:
            ok += 1
            continue

        mp4_path = ps_path[:-3] + '.mp4'
        good, msg = convert_to_mp4(ps_path, mp4_path)
        if good:
            os.remove(ps_path)
            print(f'    → {os.path.basename(mp4_path)}')
            ok += 1
        else:
            print(f'    转 mp4 失败（{msg}），保留原始 {os.path.basename(ps_path)}')
            ok += 1

    print(f'\n完成：{ok}/{len(segs)} 段，输出目录 {os.path.abspath(args.out)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
