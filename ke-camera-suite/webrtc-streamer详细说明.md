# webrtc-streamer + ONVIF PTZ 部署说明

> 所有文件已下载并配置完毕，解压即可用。
> 环境：Windows x64 + Node.js 22.x

---

## 一、已下载的文件清单

| 组件 | 版本 | 说明 |
|------|------|------|
| webrtc-streamer | **v0.8.20** (Windows-AMD64-Release) | RTSP → WebRTC 视频流服务 |
| NSSM | **2.24** | 把普通程序注册成 Windows 服务 |
| node-onvif | **0.1.7** | ONVIF 协议库（设备发现 / PTZ 控制） |
| express / cors | 4.22.3 / 2.8.6 | PTZ 服务的 HTTP 接口 |

原始安装包保留在 `_download\` 目录，可删除。

---

## 二、目录结构

```
webrtc-onvif-service\
├── webrtc-streamer\
│   ├── bin\webrtc-streamer.exe      ← 主程序 (20.7 MB)
│   ├── share\webrtc-streamer\html\  ← 内置网页播放器
│   └── logs\                        ← 服务日志输出
├── nodejs\                          ← Node.js v22.23.1 运行时 (101 MB, 解压即用)
│   ├── node.exe
│   ├── npm / npx / corepack ...
│   └── node_modules\                ← npm / corepack 本体
├── nssm\
│   └── nssm.exe                     ← 服务注册工具
├── onvif-ptz\
│   ├── server.js                    ← PTZ 控制服务 (端口 3000)
│   ├── package.json
│   ├── node_modules\                ← 依赖已装好 (8.9 MB)
│   └── logs\                        ← 服务日志输出
├── config.json                      ← 摄像头预注册配置 (可选)
├── install-service.bat              ← ① 一键注册服务
├── uninstall-service.bat            ← 卸载服务
├── firewall-rules.bat               ← ② 放行防火墙端口
└── 部署说明.md                      ← 本文件
```

---

## 三、快速部署（3 步）

### 第 0 步：把整个文件夹移到无空格的路径（强烈建议）

当前路径 `E:\codex Work\webrtc-onvif-service`
**含空格**（`codex Work`），服务长期运行可能不可靠。

建议整体移动到无空格路径：

```
C:\webrtc-onvif\
```

> 脚本用相对路径定位文件，**整个文件夹移到哪都能正常工作**，无需改任何配置。

### 第 1 步：注册服务

右键 `install-service.bat` → **以管理员身份运行**

脚本会自动完成：
- 检查管理员权限、文件完整性、依赖是否就绪
- 注册 `WebRTCStreamer` 服务（开机自启 + 崩溃自动重启 + 日志轮转）
- 注册 `OnvifPtzService` 服务（同上）
- 启动两个服务并打印状态

### 第 2 步：放行防火墙

右键 `firewall-rules.bat` → **以管理员身份运行**

| 协议 | 端口 | 用途 |
|------|------|------|
| TCP | 8000 | WebRTC 信令与网页访问 |
| TCP + UDP | 3478 | 内置 STUN 服务器 |
| UDP | 49152-65535 | WebRTC 媒体流端口范围 |
| TCP | 3000 | ONVIF PTZ 控制 API |

> 撤销：`firewall-rules.bat remove`

### 第 3 步：验证

```
http://localhost:8000            → 出现 webrtc-streamer 网页
http://localhost:3000/discover   → 返回 {"success":true,"devices":[...]}
```

---

## 四、配置说明

### 4.1 webrtc-streamer 启动参数

脚本中 `STREAMER_ARGS` 变量：

```
-H 0.0.0.0:8000 -S -R 49152:65535 -o
```

| 参数 | 作用 | 是否必须 |
|------|------|---------|
| `-H 0.0.0.0:8000` | HTTP 监听地址与端口 | 建议保留 |
| `-S` | 启动内置 STUN 服务器（3478）。不加则用 Google 公共 STUN，内网会失败 | **内网必加** |
| `-R 49152:65535` | 限定 WebRTC UDP 端口范围，便于防火墙放行 | 建议保留 |
| `-o` | null codec，不转码直传 H264，**CPU 占用大幅下降** | **强烈建议** |
| `-C config.json` | 加载预注册摄像头（见 4.2） | 可选 |

### 4.2 摄像头地址：动态传入 vs 预注册

**这是最容易踩坑的地方。** webrtc-streamer **不需要**提前配置摄像头地址。

源码逻辑（`src/PeerConnectionManager.cpp` 的 `AddStreams()`）：`/api/call?url=<值>` 的 `url` 参数先查 config 表，**没命中就把字符串本身当作 URL 直接使用**。

| | 动态模式（默认，推荐） | 预注册模式 |
|---|---|---|
| 启动参数 | 不带 `-C` | 带 `-C config.json` |
| 脚本开关 | `set USE_CONFIG=0` | `set USE_CONFIG=1` |
| 流地址来源 | 连接时由前端传入 | 从 config.json 读固定别名 |
| 摄像头增删改 | **不用重启服务** | 改完必须重启服务 |
| 前端写法 | `connect("rtsp://admin:xxx@ip:554/stream")` | `connect("Camera1")` |

**ONVIF PTZ 场景请用动态模式** —— node-onvif 的 `/getRtsp` 本来就是运行时去问摄像头要地址，预注册是多余的。

### 4.3 config.json（仅在预注册模式下生效）

```json
{
    "urls": {
        "Camera1": {
            "video": "rtsp://admin:admin123456@192.168.1.100:554/stream1",
            "options": "rtptransport=tcp&timeout=60"
        }
    }
}
```

**只认这 4 个键**，其他键会被静默忽略：

| 键 | 说明 |
|----|------|
| `video` | 视频流地址 |
| `audio` | 音频流地址（可选） |
| `options` | 拉流参数，如 `rtptransport=tcp`（海康/大华建议加，避免 UDP 丢包） |
| `position` | 地图标注坐标 `"纬度,经度"`（可选） |

> ⚠️ `"urls"` 这层包装**不能省**。程序读取的是 `config["urls"]` 子对象。

### 4.4 Node.js（已内置，无需安装）

项目自带 `nodejs\` 目录（v22.23.1，101 MB），脚本用相对路径引用：

```bat
set "NODE_EXE=%ROOT%\nodejs\node.exe"
```

**目标机器无需单独安装 Node.js**，整个文件夹拷过去直接跑。如果需要换版本，替换 `nodejs\` 目录内容即可。

---

## 五、ONVIF PTZ 服务接口

服务地址 `http://localhost:3000`，实现见 `onvif-ptz\server.js`。

| 方法 | 路径 | 参数 | 说明 |
|------|------|------|------|
| GET | `/discover` | — | 局域网 ONVIF 设备发现 |
| POST | `/getRtsp` | `deviceIndex, username, password` | 获取摄像头 RTSP 地址 |
| POST | `/ptz-control` | `deviceIndex, username, password, x, y, zoom` | 云台方向控制 |
| POST | `/ptz-stop` | `deviceIndex, username, password` | 停止云台运动 |
| POST | `/ptz-presets` | `deviceIndex, username, password` | 获取预置位列表 |
| POST | `/ptz-goto-preset` | `deviceIndex, username, password, presetToken` | 调用预置位 |

**PTZ 速度参数**（`x` / `y` / `zoom` 取值范围 `-1.0 ~ 1.0`）：

| 参数 | 方向 |
|------|------|
| `x` | 负 = 左，正 = 右 |
| `y` | 负 = 下，正 = 上 |
| `zoom` | 负 = 缩小，正 = 放大 |

**调用示例：**

```bash
# 设备发现
curl http://localhost:3000/discover

# 获取 RTSP 地址
curl -X POST http://localhost:3000/getRtsp \
  -H "Content-Type: application/json" \
  -d '{"deviceIndex":0,"username":"admin","password":"admin123456"}'

# 向右转动
curl -X POST http://localhost:3000/ptz-control \
  -H "Content-Type: application/json" \
  -d '{"deviceIndex":0,"username":"admin","password":"admin123456","x":0.5,"y":0,"zoom":0}'

# 停止
curl -X POST http://localhost:3000/ptz-stop \
  -H "Content-Type: application/json" \
  -d '{"deviceIndex":0,"username":"admin","password":"admin123456"}'
```

---

## 六、前端集成

webrtc-streamer 自带的前端库位于
`webrtc-streamer\share\webrtc-streamer\html\`：

| 文件 | 路径 | 大小 |
|------|------|------|
| `webrtcstreamer.js` | `html\webrtcstreamer.js` | 11.4 KB |
| `adapter.min.js` | `html\libs\adapter.min.js` | 129 KB |
| `webrtcstreamer.html` | `html\webrtcstreamer.html` | 官方示例页 |

> ⚠️ `adapter.min.js` 在 **`libs\` 子目录**下，不是 html 根目录。

```html
<video id="video" muted playsinline></video>

<script src="libs/adapter.min.js"></script>
<script src="webrtcstreamer.js"></script>
<script>
var webRtcServer = null;

window.onload = async function () {
    // 1. 从 PTZ 服务拿到 RTSP 地址
    const res = await fetch('http://localhost:3000/getRtsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deviceIndex: 0,
            username: 'admin',
            password: 'admin123456'
        })
    });
    const { rtsp } = await res.json();

    // 2. 交给 webrtc-streamer 播放（动态模式，直接传 RTSP 地址）
    webRtcServer = new WebRtcStreamer('video', 'http://localhost:8000');
    webRtcServer.connect(rtsp, '', 'rtptransport=tcp&timeout=60');
};

window.onbeforeunload = function () {
    if (webRtcServer) webRtcServer.disconnect();
};

// 3. 云台按钮
async function ptzMove(x, y, zoom) {
    await fetch('http://localhost:3000/ptz-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            deviceIndex: 0, username: 'admin', password: 'admin123456',
            x, y, zoom
        })
    });
}
async function ptzStop() {
    await fetch('http://localhost:3000/ptz-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceIndex: 0, username: 'admin', password: 'admin123456' })
    });
}
</script>
```

> 按钮用 `@mousedown` 触发 `ptzMove(...)`，`@mouseup` 触发 `ptzStop()`。

---

## 七、服务管理

```bat
:: 查看状态
sc query WebRTCStreamer
sc query OnvifPtzService

:: 重启 / 停止
nssm restart WebRTCStreamer
nssm restart OnvifPtzService
nssm stop    WebRTCStreamer
nssm stop    OnvifPtzService

:: 图形化管理
services.msc
```

**日志位置：**

```
webrtc-streamer\logs\stdout.log
webrtc-streamer\logs\stderr.log
onvif-ptz\logs\stdout.log
onvif-ptz\logs\stderr.log
```

日志超过 10 MB 自动轮转。

**卸载：** 管理员运行 `uninstall-service.bat`（只删服务，不删程序文件）。

---

## 八、常见问题

| 现象 | 原因与处理 |
|------|-----------|
| 浏览器打开 8000 空白 | 看 `webrtc-streamer\logs\stderr.log`；确认服务已启动 `sc query WebRTCStreamer` |
| 页面能开但视频黑屏 | ① 防火墙未放行 UDP 49152-65535；② 内网缺 `-S` 参数；③ RTSP 地址或账号密码错误 |
| `/discover` 返回空数组 | 摄像头与服务器不在同一网段，或摄像头未开启 ONVIF。检查摄像头后台是否启用 ONVIF 并创建了 ONVIF 用户 |
| PTZ 指令无反应 | 摄像头不支持 PTZ，或该 ONVIF 用户无 PTZ 权限；`getCurrentProfile()` 拿到的 profile 可能不是 PTZ profile |
| 服务启动后立即停止 | 看 `logs\stderr.log`。常见是端口被占用（`netstat -ano \| findstr :8000`） |
| 修改了脚本参数不生效 | 重新以管理员运行 `install-service.bat`（脚本会先删除同名旧服务再重建） |

### ⚠️ 编辑 .bat 文件的编码陷阱

三个 `.bat` 文件是 **GBK (cp936) + CRLF** 编码，这是中文 Windows 下最稳妥的组合。

**不要用 VS Code / Notepad++ 的默认 UTF-8 保存**，否则中文全部变乱码、脚本可能直接报错。

正确的编辑方式：
- **记事本**：直接编辑保存即可（中文 Windows 默认 ANSI 就是 GBK）
- **VS Code**：右下角编码切到 `GBK`，或用 "Reopen with Encoding → GBK" 后再编辑
- **Notepad++**：菜单 `编码 → 转为 ANSI 编码` 后再保存

改完可用 `chcp` 确认：在 cmd 里 `type install-service.bat` 能正常显示中文即为正确。

---

## 九、安全建议

1. **不要把 8000 / 3000 端口直接暴露到公网。** 两个服务默认无鉴权，任何人都能拉流和操作云台。
2. **内网使用**：防火墙规则可追加 `remoteip=localsubnet` 限定本网段。
3. **动态模式下**，RTSP 地址（含摄像头账号密码）会出现在浏览器发往 8000 的请求里。环境不可信时改用预注册模式，把凭据留在服务端。
4. **公网部署**需要额外做：
   - 用 TURN 服务器（`-T` / `-t` 参数）穿透 NAT
   - 在反向代理（Nginx）层加 HTTPS + 认证
   - webrtc-streamer 自身可用 `-A passwd` 开启 HTTP 基础认证
5. **摄像头账号**不要用默认的 `admin/admin`，在摄像头后台单独创建一个仅含所需权限的 ONVIF 账号。

---

## 十、版本与来源

| 文件 | 来源 |
|------|------|
| webrtc-streamer v0.8.20 | https://github.com/mpromonet/webrtc-streamer/releases |
| NSSM 2.24 | https://nssm.cc/download |
| node-onvif 0.1.7 | https://www.npmjs.com/package/node-onvif |

> 本机直连 GitHub Release 被网络策略拦截（502），webrtc-streamer 通过镜像 `ghproxy.net` 下载。
