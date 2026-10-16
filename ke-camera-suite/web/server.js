'use strict';
/**
 * 摄像头调试台 —— 极简静态服务器
 *
 * 零依赖（只用 Node 内置模块），只做两件事：
 *   1. 把 web/ 目录下的页面通过 http 提供出去（避免 file:// 协议下的各种限制）
 *   2. 启动后自动打开浏览器
 *
 * 用法：
 *   node web/server.js                 默认端口 8080，自动开浏览器
 *   node web/server.js --port 9000     指定端口
 *   node web/server.js --no-open       不自动开浏览器
 *   WEB_PORT=9000 node web/server.js   用环境变量指定端口
 *
 * 关闭窗口（或 Ctrl+C）即停止。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;

// ------------------------------------------------------------ 参数

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const START_PORT = Number(argValue('--port') || process.env.WEB_PORT || 8080);
const NO_OPEN = process.argv.includes('--no-open');

// ------------------------------------------------------------ MIME

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
};

// ------------------------------------------------------------ 请求处理

function handle(req, res) {
    let pathname;
    try {
        pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('400 请求地址无法解析');
    }

    if (pathname === '/' || pathname === '') pathname = '/index.html';

    // 防目录穿越：显式拒绝含 .. 的路径
    if (pathname.indexOf('..') >= 0) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 禁止访问');
    }

    // 强制按相对路径解析，解析结果必须仍在 web/ 目录内
    const file = path.resolve(ROOT, '.' + pathname);
    if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('403 禁止访问');
    }

    // 不对外暴露服务端脚本自身
    if (path.basename(file).toLowerCase() === 'server.js') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 文件不存在');
    }

    fs.readFile(file, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('404 文件不存在: ' + pathname);
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Content-Length': data.length,
            'Cache-Control': 'no-store',
        });
        res.end(data);
    });
}

// ------------------------------------------------------------ 打开浏览器

function openBrowser(url) {
    const cmd =
        process.platform === 'win32' ? `start "" "${url}"` :
        process.platform === 'darwin' ? `open "${url}"` :
        `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) {
            console.log('  [提示] 未能自动打开浏览器，请手动访问: ' + url);
        }
    });
}

// ------------------------------------------------------------ 启动

function banner(port) {
    console.log('');
    console.log('============================================');
    console.log('  摄像头调试台');
    console.log('============================================');
    console.log('  页面地址 : http://localhost:' + port);
    console.log('  页面目录 : ' + ROOT);
    console.log('');
    console.log('  页面内需要填写三个后端服务的地址：');
    console.log('    WebRTC  :8000   实时播放');
    console.log('    PTZ     :3000   云台控制');
    console.log('    下载    :3001   历史录像下载');
    console.log('');
    console.log('  关闭本窗口（或 Ctrl+C）即停止。');
    console.log('============================================');
    console.log('');
}

let port = START_PORT;
let attempts = 0;

function start() {
    const server = http.createServer(handle);

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
            console.log('  [提示] 端口 ' + port + ' 已被占用，尝试 ' + (port + 1));
            port += 1;
            attempts += 1;
            setTimeout(start, 100);
            return;
        }
        console.error('  [错误] 服务启动失败: ' + err.message);
        process.exit(1);
    });

    server.listen(port, '0.0.0.0', () => {
        const url = 'http://localhost:' + port;
        banner(port);
        if (!NO_OPEN) openBrowser(url);
    });
}

start();
