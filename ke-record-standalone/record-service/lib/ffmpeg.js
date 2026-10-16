'use strict';
/**
 * ffmpeg 封装
 *
 * ffmpeg.exe 路径按这个优先级解析：
 *   1. 环境变量 FFMPEG_PATH   （install-service.bat 会自动写入）
 *   2. ke-camera-suite\tools\ffmpeg.exe   ← 包内自带，推荐
 *   3. 系统 PATH 里的 ffmpeg
 *
 * 为什么不能只靠系统 PATH：本服务由 NSSM 以 LocalSystem 身份启动，
 * 看不到"用户级"PATH，所以包内自带一份最稳。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';

function resolveFfmpeg() {
    if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
        return process.env.FFMPEG_PATH;
    }
    const local = path.join(__dirname, '..', '..', 'tools', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(local)) return local;

    return 'ffmpeg';
}

const FFMPEG = resolveFfmpeg();

const TIME_RE = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;

/**
 * 跑一次 ffmpeg，返回退出码。-1 表示启动失败或超时。
 * @param {string[]} args
 * @param {(seconds:number)=>void} [onSeconds]
 * @param {number} [timeoutMs]
 */
function run(args, onSeconds, timeoutMs = 30 * 60 * 1000) {
    return new Promise((resolve) => {
        let proc;
        try {
            proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        } catch {
            resolve(-1);
            return;
        }

        let buf = '';
        const handle = (chunk) => {
            if (!onSeconds) return;
            buf += chunk.toString('utf8');
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                const m = TIME_RE.exec(line);
                if (m) onSeconds(Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]));
            }
        };
        proc.stdout.on('data', handle);
        proc.stderr.on('data', handle);

        const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
        proc.on('close', (code) => { clearTimeout(timer); resolve(code === null ? -1 : code); });
        proc.on('error', () => { clearTimeout(timer); resolve(-1); });
    });
}

const okFile = (p) => {
    try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; }
};

/** 海康 PS 流 -> mp4。先无损封装，不行再降级转码 */
async function toMp4(input, output) {
    const attempts = [
        ['-c', 'copy', '-tag:v', 'hvc1'],
        ['-c:v', 'copy', '-c:a', 'aac'],
        ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac'],
    ];
    for (const extra of attempts) {
        const code = await run(['-hide_banner', '-loglevel', 'error', '-y', '-i', input, ...extra, output]);
        if (code === 0 && okFile(output)) return true;
    }
    return false;
}

/** 多段合并成一条视频 */
async function concat(parts, output) {
    if (!parts.length) return false;

    if (parts.length === 1) {
        try { fs.copyFileSync(parts[0], output); return okFile(output); } catch { return false; }
    }

    const listFile = `${output}.concat.txt`;
    try {
        fs.writeFileSync(
            listFile,
            parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n') + '\n',
            'utf8',
        );
    } catch { return false; }

    const code = await run(['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', output]);

    try { fs.unlinkSync(listFile); } catch { /* ignore */ }

    return code === 0 && okFile(output);
}

/** 直接拉 RTSP 回放流存 mp4 —— 不需要 ISAPI，设备需支持带时间参数的 RTSP 回放 */
async function pullRtsp(rtspUrl, output, onSeconds) {
    const code = await run(['-hide_banner', '-loglevel', 'info', '-y',
        '-rtsp_transport', 'tcp', '-i', rtspUrl,
        '-c', 'copy', '-tag:v', 'hvc1', output], onSeconds);
    return code === 0 && okFile(output);
}

/** 探测 ffmpeg 是否可用 */
function available() {
    return run(['-version'], null, 10000).then((c) => c === 0);
}

module.exports = { run, toMp4, concat, pullRtsp, available, FFMPEG };
