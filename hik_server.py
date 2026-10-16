#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
海康 NVR 录像下载 —— 后端代理服务（纯标准库，零依赖）

为什么需要这一层：
  浏览器不能直连 NVR 的 ISAPI —— 跨域被拦、fetch 不处理 Digest 认证、
  返回的 PS 流浏览器无法转码。所以由后端代劳，Vue 只负责传参和收文件。

启动：
  python hik_server.py --host 192.168.1.64 -u admin -p 你的密码 --port 8000

接口：
  GET  /api/records?channel=1&start=2026-10-15 08:00:00&end=2026-10-15 09:00:00
       -> {"ok":true,"segments":[{"start":..,"end":..,"uri":..}]}
  POST /api/download   {"channel":1,"start":"...","end":"..."}
       -> {"ok":true,"file":"ch1_xxx.mp4","size":12345678}
  GET  /api/file?name=ch1_xxx.mp4
       -> mp4 文件流（Content-Disposition: attachment）
"""

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import hik_download as hk

CFG = {
    'host': '192.168.1.64',
    'port': 80,
    'user': 'admin',
    'password': '',
    'tz': 8,
    'outdir': os.path.join(tempfile.gettempdir(), 'hik_records'),
}

MIME = {
    '.mp4': 'video/mp4',
    '.ps': 'application/octet-stream',
}


def base_url():
    return f"http://{CFG['host']}:{CFG['port']}"


def safe_name(name):
    """只保留字母数字和 _.- ，防路径穿越。"""
    name = os.path.basename(name or '')
    return re.sub(r'[^A-Za-z0-9_.-]', '', name)


def do_search(channel, start_local, end_local, stream='main'):
    track = int(channel) * 100 + (1 if stream == 'main' else 2)
    start_utc = hk.parse_local(start_local, CFG['tz'])
    end_utc = hk.parse_local(end_local, CFG['tz'])
    opener = hk.make_opener(base_url(), CFG['user'], CFG['password'])
    segs = hk.search_segments(opener, base_url(), track, start_utc, end_utc, verbose=False)
    return segs, start_utc, end_utc


def do_download(channel, start_local, end_local, stream='main'):
    """下载 + 转 mp4 + 多段合并，返回 (文件名, 大小)。"""
    segs, start_utc, end_utc = do_search(channel, start_local, end_local, stream)
    if not segs:
        raise RuntimeError('该时间段没有录像（未配置录像计划 / 已被循环覆盖 / 时间写错）')

    os.makedirs(CFG['outdir'], exist_ok=True)
    workdir = tempfile.mkdtemp(prefix='hikjob_', dir=CFG['outdir'])
    opener = hk.make_opener(base_url(), CFG['user'], CFG['password'])

    mp4s = []
    for i, s in enumerate(segs):
        ps = os.path.join(workdir, f'{i:03d}.ps')
        hk.download_segment(opener, base_url(), s['uri'], ps)
        if os.path.getsize(ps) == 0:
            os.remove(ps)
            continue
        mp4 = os.path.join(workdir, f'{i:03d}.mp4')
        ok, msg = hk.convert_to_mp4(ps, mp4)
        os.remove(ps)
        if ok:
            mp4s.append(mp4)

    if not mp4s:
        raise RuntimeError('下载到的流为空，可能是该段录像不存在或已被覆盖')

    # 多段合并成一条完整视频
    if len(mp4s) == 1:
        merged = mp4s[0]
    else:
        listfile = os.path.join(workdir, 'list.txt')
        with open(listfile, 'w', encoding='utf-8') as f:
            for m in mp4s:
                f.write("file '%s'\n" % m.replace('\\', '/'))
        merged = os.path.join(workdir, 'merged.mp4')
        subprocess.run(
            ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
             '-f', 'concat', '-safe', '0', '-i', listfile, '-c', 'copy', merged],
            capture_output=True,
        )
        if not (os.path.exists(merged) and os.path.getsize(merged) > 0):
            merged = mp4s[0]  # 合并失败就退回第一段，至少不丢数据

    name = 'ch%d_%s_%s.mp4' % (
        int(channel),
        start_utc.strftime('%Y%m%d_%H%M%S'),
        end_utc.strftime('%H%M%S'),
    )
    final = os.path.join(CFG['outdir'], name)
    if os.path.exists(final):
        os.remove(final)
    os.replace(merged, final)
    return name, os.path.getsize(final)


class Handler(BaseHTTPRequestHandler):
    server_version = 'HikProxy/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)

        if u.path == '/api/records':
            try:
                segs, _, _ = do_search(
                    q.get('channel', ['1'])[0],
                    q.get('start', [''])[0],
                    q.get('end', [''])[0],
                    q.get('stream', ['main'])[0],
                )
                self._json({'ok': True, 'segments': segs})
            except Exception as e:
                self._json({'ok': False, 'error': str(e)}, 500)

        elif u.path == '/api/file':
            name = safe_name(q.get('name', [''])[0])
            path = os.path.join(CFG['outdir'], name)
            if not name or not os.path.isfile(path):
                self._json({'ok': False, 'error': '文件不存在'}, 404)
                return
            size = os.path.getsize(path)
            ext = os.path.splitext(name)[1].lower()
            self.send_response(200)
            self.send_header('Content-Type', MIME.get(ext, 'application/octet-stream'))
            self.send_header('Content-Length', str(size))
            self.send_header('Content-Disposition',
                             "attachment; filename=\"%s\"" % name)
            self._cors()
            self.end_headers()
            with open(path, 'rb') as f:
                while True:
                    chunk = f.read(512 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)

        elif u.path == '/api/health':
            self._json({'ok': True, 'device': base_url()})

        else:
            self._json({'ok': False, 'error': 'not found'}, 404)

    def do_POST(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != '/api/download':
            self._json({'ok': False, 'error': 'not found'}, 404)
            return
        try:
            n = int(self.headers.get('Content-Length', 0))
            payload = json.loads(self.rfile.read(n) or b'{}')
            name, size = do_download(
                payload.get('channel', 1),
                payload['start'],
                payload['end'],
                payload.get('stream', 'main'),
            )
            self._json({'ok': True, 'file': name, 'size': size})
        except Exception as e:
            self._json({'ok': False, 'error': str(e)}, 500)


def main():
    ap = argparse.ArgumentParser(description='海康录像下载后端代理')
    ap.add_argument('--host', required=True, help='NVR 的 IP')
    ap.add_argument('--nvr-port', type=int, default=80, help='NVR HTTP 端口，默认 80')
    ap.add_argument('-u', '--user', default='admin')
    ap.add_argument('-p', '--password', required=True)
    ap.add_argument('--tz', type=float, default=8, help='输入时间的时区，默认 8')
    ap.add_argument('--port', type=int, default=8000, help='本服务监听端口')
    ap.add_argument('--outdir', default=CFG['outdir'], help='成品文件目录')
    args = ap.parse_args()

    CFG.update({
        'host': args.host,
        'port': args.nvr_port,
        'user': args.user,
        'password': args.password,
        'tz': args.tz,
        'outdir': args.outdir,
    })
    os.makedirs(CFG['outdir'], exist_ok=True)

    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'设备      : {base_url()}')
    print(f'服务地址  : http://127.0.0.1:{args.port}')
    print(f'成品目录  : {os.path.abspath(CFG["outdir"])}')
    print('按 Ctrl+C 停止')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')


if __name__ == '__main__':
    sys.exit(main())
