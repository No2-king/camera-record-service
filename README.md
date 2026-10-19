# 摄像头录像服务（ke_camera_serve）

> 一套围绕 **海康（Hikvision）NVR / 摄像头** 的接入工具集：
> **历史录像下载** + **实时播放** + **云台控制**。
> 从「原理验证脚本」到「可直接部署的自包含服务包」，一应俱全。

支持 **Python / Node.js / Java** 三种后端参考实现，以及开箱即用的 Windows / Linux 部署包。

---

## 一、解决什么问题

摄像头 / NVR 的历史录像存在设备本地，但**浏览器无法直接把它取下来**：

| 障碍 | 具体表现 |
|---|---|
| **跨域（CORS）** | 浏览器直连设备 `http://192.168.x.x` 会被同源策略拦截 |
| **Digest 认证** | 海康 ISAPI 用 HTTP **Digest** 认证，`fetch` / `XHR` 不会自动完成握手 |
| **私有流格式** | 下载的是海康私有 **PS 流**，浏览器播不了，剪辑软件也认不出 |

因此本项目的核心思路是 **由后端代理代劳**：
浏览器只负责传参数、收文件；后端负责认证、检索、下载、转码、合并。

```
┌──────────┐   简单 JSON    ┌──────────────┐   ISAPI/Digest   ┌──────────┐
│ 浏览器/前端│ ─────────────▶ │  后端代理服务  │ ───────────────▶ │ 海康设备  │
│ (Vue/调试台)│ ◀───────────── │ (Node/Python/Java)│ ◀────────────── │ NVR/摄像头│
└──────────┘   mp4 文件流    └──────────────┘   私有 PS 流      └──────────┘
                                    │
                                    ▼ ffmpeg
                             PS 流 → 标准 mp4
```

---

## 二、核心原理

```
① 查录像段   POST /ISAPI/ContentMgmt/search    → 拿到 playbackURI 列表
② 下载流     POST /ISAPI/ContentMgmt/download  → 海康私有 PS 流
③ 转 mp4     ffmpeg -i xxx.ps -c copy xxx.mp4
④ 多段合并   ffmpeg -f concat -c copy final.mp4
⑤ 返回文件   GET  /file?name=xxx.mp4
```

跨多个录像段时会自动合并成**一条完整视频**。

**几个关键点：**

- **Digest 认证手写**：Node 原生 `fetch`、JDK `HttpClient`、Python 标准库都不支持 Digest，
  故在三种语言里都手写了握手（先拿 `401 + WWW-Authenticate`，算摘要后重发）。
- **trackID 规则**：`通道号 × 100 + 码流位`（通道1主码流 = `101`，子码流 = `102`，通道2 = `201`）。
- **时区**：接口填**设备上显示的时间**即可，服务**不做时区换算**（`tz` 默认 `0`）。
  实测海康设备忽略时间字段末尾的 `Z`，按本地时间解析；早期版本按 +8 减 8 小时会让画面早 8 小时。
- **转码降级链**：`copy → 仅转音频 → 完全转码`，自动重试直到成功。
- **RTSP 回放捷径**：支持让 ffmpeg 直接拉带时间参数的 RTSP 回放流（快，但查不到有无录像）。

---

## 三、仓库组成

```
ke_camera_serve\
├── hik_download.py           【Python】命令行下载工具（零依赖）
├── hik_server.py             【Python】HTTP 代理服务（零依赖）
├── RecordDownload.vue        【Vue 3】录像下载组件
│
├── node\                     【Node.js 参考实现】零依赖，Node 18+
│   ├── hik-client.mjs        ISAPI 客户端（手写 Digest）
│   ├── hik-service.mjs       业务编排：搜索 → 下载 → 转码 → 合并
│   ├── ffmpeg-runner.mjs     ffmpeg 调用封装
│   ├── server.mjs            HTTP 服务
│   └── test-digest.mjs       Digest 算法自测（RFC 2617 标准向量）
│
├── java\hik\                 【Java 参考实现】零依赖，JDK 15+
│   ├── HikIsapiClient.java   ISAPI 客户端（手写 Digest）
│   ├── HikRecordService.java 业务编排（同步 / 异步，Spring 可注入）
│   └── FfmpegRunner.java     ffmpeg 调用封装
│
├── ke-camera-suite\          【完整套件 · 可部署】三服务 + 调试台
└── ke-record-standalone\     【独立下载包 · 可部署】仅录像下载
```

### 两个可部署包

| 包 | 内容 | 适用场景 |
|---|---|---|
| **ke-camera-suite** | 实时播放 + 云台控制 + 录像下载 + 调试台 | 需要完整摄像头能力 |
| **ke-record-standalone** | 仅录像下载服务 | 只要“导出历史录像” |

> 两包中的**录像下载服务是同一份代码、同一套接口**。两包均**自包含**
> （自带 nssm / ffmpeg，Node.js 为可选兜底），解压即用，无需联网安装依赖。
> 安装脚本会**优先使用本机已装的 Node.js**，本机没有才回落到包内的 `nodejs\`。

#### ke-camera-suite 三大服务

| 服务 | 端口 | 技术 | 作用 |
|---|:---:|---|---|
| `KE-WebRTCStreamer` | 8000 | webrtc-streamer | RTSP → WebRTC，浏览器实时播放，延迟 < 500ms |
| `KE-OnvifPtzService` | 3000 | Express + onvif@0.8 | 云台方向 / 缩放 / 预置位控制，获取 RTSP 地址 |
| `KE-RecordService` | 3001 | 零依赖 Node | 历史录像下载，按时间段导出 mp4 |

---

## 四、快速开始

### 方式 A：使用自包含包（推荐）

```bat
REM Windows —— 需管理员权限
install-service.bat        REM ① 注册并启动服务
firewall-rules.bat         REM ② 放行防火墙端口
start-web.bat              REM ③ 打开本地调试台（推荐）
```

| 地址 | 期望结果 |
|---|---|
| `http://localhost:8000` | webrtc-streamer 播放器页面 |
| `http://localhost:3000/health` | `{"success":true,...}` |
| `http://localhost:3001` | 录像下载服务信息页 |
| `http://localhost:3001/health` | 含 `"ffmpegAvailable": true` |

> Linux：`sudo bash linux/install.sh`（生成 systemd 服务）。

### 方式 B：直接调用下载 API

```bash
# ① 查那段时间有没有录像
curl -X POST http://localhost:3001/search -H "Content-Type: application/json" \
  -d '{"cameraIp":"192.168.1.100","isapiPort":80,"userName":"admin","password":"admin123","channel":1,"start":"2026-10-15 08:00:00","end":"2026-10-15 09:00:00"}'

# ② 发起下载 → 返回 taskId
curl -X POST http://localhost:3001/download -H "Content-Type: application/json" \
  -d '{"cameraIp":"192.168.1.100","isapiPort":80,"userName":"admin","password":"admin123","channel":1,"start":"2026-10-15 08:00:00","end":"2026-10-15 09:00:00"}'

# ③ 轮询进度
curl "http://localhost:3001/progress?taskId=a1b2c3d4"

# ④ 取文件
curl -O -J "http://localhost:3001/file?name=ch1_20261015_080000_090000.mp4"
```

### 方式 C：命令行工具（参考实现）

```bash
# Python
python hik_download.py --host 192.168.1.64 -u admin -p 你的密码 \
    --channel 1 --start "2026-10-15 08:00:00" --end "2026-10-15 09:00:00"

# Node.js
node node/server.mjs --host 192.168.1.64 -u admin -p 你的密码 --port 8000
```

---

## 五、文档

| 文档 | 位置 | 内容 |
|---|---|---|
| **操作文档.md** | 根目录 | 安装、启动、使用、排查（总入口） |
| **项目介绍.md** | 根目录 | 项目定位、原理、结构、技术栈 |
| 使用说明.md | `ke-camera-suite/` | 完整套件使用说明 |
| 接口文档.md | 各包内 | 下载服务完整 API（参数 / 字段 / 错误码） |
| Linux部署指南.md | 各包内 | Linux 环境部署步骤 |
| webrtc-streamer详细说明.md | `ke-camera-suite/` | webrtc-streamer 参数与 API |
| 使用说明.md | `ke-record-standalone/` | 独立下载包使用说明 |

---

## 六、环境变量（下载服务）

| 变量 | 默认 | 说明 |
|---|---|---|
| `RECORD_PORT` | `3001` | 监听端口 |
| `RECORD_DIR` | `<服务目录>/downloads` | 成品输出目录 |
| `RECORD_TZ` | `0` | 默认时区偏移，`0` = 不换算 |
| `RECORD_CONCURRENCY` | `2` | 并发下载任务数 |
| `ISAPI_PORT` | `80` | 默认 ISAPI 端口（请求参数优先） |
| `FFMPEG_PATH` | 包内 `tools/ffmpeg[.exe]` | ffmpeg 路径 |

---

## 七、注意事项

- **本仓库不含大体积二进制**（`ffmpeg.exe` / `node.exe` / `webrtc-streamer`，见 `.gitignore`）。
  需要完整可运行包时，请自行下载上述组件，或使用 GitHub Release 附件。
- 下载服务**对外不鉴权**，生产环境请通过防火墙限制来源网段，或放在 Nginx 后加认证。
- 设备侧使用 **HTTP Digest 认证**（非 Basic），服务内部已处理。

---

## 八、License

本项目未声明开源许可证，默认保留所有权利。
如需商用或二次分发，请先与作者联系。
