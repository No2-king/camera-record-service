/**
 * ONVIF PTZ Control Service
 *
 * Express + onvif@0.8 服务，提供 REST API 用于：
 *   - ONVIF 摄像头云台方向控制 (上下左右/缩放)
 *   - 停止 PTZ 运动、调用预置位、获取预置位列表
 *   - 获取摄像头 RTSP 流地址
 *
 * 摄像头通过前端动态注册（前端拼好 xaddr 直接传），无需先 discover。
 * 使用 onvif@0.8.x 的 Cam 类（而非 node-onvif 0.1.7），解决认证失败问题。
 *
 * 端口: 3000
 */

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Cam } = require('onvif');
const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());

/** 摄像头连接缓存：xaddr -> Cam 实例 */
const camCache = new Map();

// ============================================================
// 辅助: 根据请求体创建/获取 Cam 实例 (动态注册, 无需 discover)
// ============================================================
async function getCam(req) {
    const { xaddr, cameraIp, cameraPort, userName, password } = req.body;

    let cacheKey, camConfig;

    if (xaddr && userName && password) {
        // 前端已拼好 ONVIF 完整地址 (推荐方式)
        const cleanXaddr = String(xaddr).trim().replace(/^[`'"]+|[`'"]+$/g, '');
        const m = cleanXaddr.match(/^https?:\/\/([^/:]+)(?::(\d+))?/);
        if (!m) throw new Error(`xaddr 格式错误: ${cleanXaddr}`);
        cacheKey = cleanXaddr;
        camConfig = {
            hostname: m[1],
            port: Number(m[2]) || 80,
            username: userName,
            password,
        };
    } else if (cameraIp && userName && password) {
        // 兜底: 前端传 IP + 端口
        const port2 = Number(cameraPort) || 9080;
        cacheKey = `${cameraIp}:${port2}`;
        camConfig = {
            hostname: cameraIp,
            port: port2,
            username: userName,
            password,
        };
    } else {
        throw new Error('PTZ 请求缺少连接参数：需要 xaddr + userName + password');
    }

    if (camCache.has(cacheKey)) return camCache.get(cacheKey);

    const cam = new Cam(camConfig);
    await new Promise((resolve, reject) => {
        cam.connect(err => (err ? reject(err) : resolve()));
    });
    camCache.set(cacheKey, cam);
    console.log(`[PTZ] 已连接摄像头: ${camConfig.hostname}:${camConfig.port} (${cacheKey})`);
    return cam;
}

/** 回调转 Promise 的通用包装 */
function camAsync(cam, method, params) {
    return new Promise((resolve, reject) => {
        if (params) {
            cam[method](params, err => (err ? reject(err) : resolve()));
        } else {
            cam[method](err => (err ? reject(err) : resolve()));
        }
    });
}

// ============================================================
// ① PTZ 方向控制 — POST /ptz-control
// Body: { xaddr, userName, password, x, y, zoom }
//   x:    -1.0 ~ 1.0 (左 ~ 右)
//   y:    -1.0 ~ 1.0 (下 ~ 上)
//   zoom: -1.0 ~ 1.0 (缩小 ~ 放大)
// 兼容: cameraId (忽略) / deviceIndex / username / pass 字段名
// ============================================================
app.post('/ptz-control', async (req, res) => {
    const b = req.body;
    const x = b.x != null ? Number(b.x) : 0;
    const y = b.y != null ? Number(b.y) : 0;
    const zoom = b.zoom != null ? Number(b.zoom) : 0;
    try {
        // 兼容 userName/user/username, password/pass
        if (!req.body.userName && req.body.username) req.body.userName = req.body.username;
        if (!req.body.password && req.body.pass) req.body.password = req.body.pass;
        const cam = await getCam(req);
        // 子参数放顶层 (onvif 0.8 的方式), timeout 单位毫秒, 5 秒后自动停, 防止 mouseup 丢失时云台持续转动
        await camAsync(cam, 'continuousMove', {
            profileToken: cam.activeSource.profileToken,
            x, y, zoom,
            timeout: 5000,
        });
        console.log(`[PTZ] 移动: x=${x} y=${y} zoom=${zoom}`);
        res.json({ success: true, message: 'PTZ 移动指令已发送' });
    } catch (err) {
        console.error('[PTZ] 控制失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ② PTZ 停止 — POST /ptz-stop
// Body: { xaddr, userName, password }
// ============================================================
app.post('/ptz-stop', async (req, res) => {
    try {
        if (!req.body.userName && req.body.username) req.body.userName = req.body.username;
        if (!req.body.password && req.body.pass) req.body.password = req.body.pass;
        const cam = await getCam(req);
        await camAsync(cam, 'stop', {
            profileToken: cam.activeSource.profileToken,
            panTilt: true,
            zoom: true,
        });
        console.log('[PTZ] 已停止');
        res.json({ success: true, message: 'PTZ 已停止' });
    } catch (err) {
        console.error('[PTZ] 停止失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ③ 获取 RTSP 流地址 — POST /getRtsp
// Body: { xaddr, userName, password }
// ============================================================
app.post('/getRtsp', async (req, res) => {
    try {
        if (!req.body.userName && req.body.username) req.body.userName = req.body.username;
        if (!req.body.password && req.body.pass) req.body.password = req.body.pass;
        const cam = await getCam(req);
        const profileToken = cam.activeSource.profileToken;
        const result = await camAsync(cam, 'getStreamUri', {
            profileToken,
            streamSetup: { stream: 'RTP-Unicast', transport: { protocol: 'RTSP' } },
        });
        // onvif 0.8 返回 { uri: '...' } 或 result.data
        const uri = result.uri || (result.data && result.data.Uri) || (result.uri && result.uri.Uri) || null;
        console.log(`[PTZ] 获取RTSP: ${uri}`);
        res.json({ success: true, rtsp: uri });
    } catch (err) {
        console.error('[PTZ] 获取RTSP失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ④ 获取预置位列表 — POST /ptz-presets
// Body: { xaddr, userName, password }
// ============================================================
app.post('/ptz-presets', async (req, res) => {
    try {
        if (!req.body.userName && req.body.username) req.body.userName = req.body.username;
        if (!req.body.password && req.body.pass) req.body.password = req.body.pass;
        const cam = await getCam(req);
        const profileToken = cam.activeSource.profileToken;
        let result = await camAsync(cam, 'getPresets', { profileToken });
        // onvif 0.8 getPresets 回调返回的是 xml (string), 不直接返回对象
        res.json({ success: true, presets: result, raw: typeof result });
    } catch (err) {
        console.error('[PTZ] 获取预置位失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ⑤ 调用预置位 — POST /ptz-goto-preset
// Body: { xaddr, userName, password, presetToken }
// ============================================================
app.post('/ptz-goto-preset', async (req, res) => {
    const presetToken = req.body.presetToken != null ? req.body.presetToken : 1;
    try {
        if (!req.body.userName && req.body.username) req.body.userName = req.body.username;
        if (!req.body.password && req.body.pass) req.body.password = req.body.pass;
        const cam = await getCam(req);
        const profileToken = cam.activeSource.profileToken;
        await camAsync(cam, 'gotoPreset', { profileToken, presetToken });
        console.log(`[PTZ] 调用预置位: ${presetToken}`);
        res.json({ success: true, message: '预置位调用成功' });
    } catch (err) {
        console.error('[PTZ] 预置位失败:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ============================================================
// ⑥ 健康检查
// ============================================================
app.get('/health', (req, res) => {
    res.json({ success: true, service: 'onvif-ptz', mode: 'onvif@0.8-dynamic-registration' });
});

// ============================================================
// 启动服务
// ============================================================
app.listen(port, () => {
    console.log('========================================');
    console.log('  ONVIF PTZ Control Service  (onvif@0.8)');
    console.log('========================================');
    console.log(`  监听端口: ${port}`);
    console.log(`  API 地址: http://localhost:${port}`);
    console.log('----------------------------------------');
    console.log('  接口列表:');
    console.log('    POST /ptz-control      - PTZ方向控制 (x/y/zoom 顶层)');
    console.log('    POST /ptz-stop          - 停止PTZ');
    console.log('    POST /getRtsp           - 获取RTSP地址');
    console.log('    POST /ptz-presets       - 获取预置位列表');
    console.log('    POST /ptz-goto-preset   - 调用预置位');
    console.log('    GET  /health            - 健康检查');
    console.log('========================================');
    console.log('  摄像头动态注册: 前端传 xaddr + userName + password');
});