# Linux 部署指南

本指南适用于 **ke-camera-suite**（完整套件）和 **ke-record-standalone**（独立下载服务）两个包。

---

## 一、先说清楚：Windows 包里哪些东西 Linux 不能用

Windows 包是**自包含**的，但里面有几个二进制是 Windows 专有的，搬到 Linux 必须换掉：

| 组件 | Linux 能否直接用 | 说明 |
|---|:---:|---|
| `record-service/` | ✅ **可以直接用** | 纯 Node 脚本，零平台依赖 |
| `onvif-ptz/`（server.js） | ✅ **可以直接用** | 纯 Node 脚本，但 `node_modules` 建议重装 |
| `onvif-ptz/node_modules/` | ⚠️ 建议重装 | 部分包可能带平台相关产物 |
| `nodejs/` | ❌ | 是 Windows 版 `node.exe`，Linux 需另装 |
| `nssm/` | ❌ | Windows 服务工具，Linux 用 **systemd** |
| `tools/ffmpeg.exe` | ❌ | Windows 版，Linux 用 `apt/dnf` 装 |
| `webrtc-streamer/bin/*.exe` | ❌ | 需下载 Linux 版二进制 |
| `*.bat` | ❌ | 用下面提供的 `linux/install.sh` 替代 |

**好消息**：核心业务代码（`server.js` / `lib/isapi.js` / `lib/ffmpeg.js`）是**跨平台**的，
`lib/ffmpeg.js` 已经按平台自动找 ffmpeg：

```js
const local = path.join(__dirname, '..', '..', 'tools', IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
if (fs.existsSync(local)) return local;   // 包内自带优先
return 'ffmpeg';                          // 否则走系统 PATH
```

所以 Linux 上只要**系统装了 ffmpeg**，代码不用改一行。

---

## 二、环境准备

### 2.1 安装 Node.js（18 以上，推荐 20 LTS）

**Debian / Ubuntu**

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

**CentOS / RHEL / Rocky / AlmaLinux**

```bash
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo dnf install -y nodejs
node -v && npm -v
```

**不想加第三方源？** 直接下官方二进制：

```bash
cd /tmp
curl -LO https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-x64.tar.xz
sudo tar -xf node-v20.18.0-linux-x64.tar.xz -C /usr/local --strip-components=1
node -v
```

### 2.2 安装 ffmpeg

```bash
# Debian / Ubuntu
sudo apt update && sudo apt install -y ffmpeg

# CentOS / RHEL / Rocky（需 EPEL）
sudo dnf install -y epel-release
sudo dnf install -y ffmpeg

# 验证
ffmpeg -version | head -1
```

装完后 `which ffmpeg` 应有输出（通常在 `/usr/bin/ffmpeg`）。下载服务会自动找到它。

> 如果一定要用包内自带的 Linux 版 ffmpeg，把它放到包根目录的 `tools/ffmpeg`
> （**注意没有 `.exe` 后缀**），代码会优先用它。

---

## 三、部署方案 A：只装录像下载服务

对应 **ke-record-standalone** 包。

### 3.1 放置文件

```bash
sudo mkdir -p /opt/ke-record
sudo cp -r record-service /opt/ke-record/
sudo mkdir -p /opt/ke-record/record-service/{logs,downloads}
```

最终结构：

```
/opt/ke-record/record-service/
├── server.js
├── lib/isapi.js
├── lib/ffmpeg.js
├── logs/
└── downloads/
```

### 3.2 创建 systemd 服务

```bash
sudo tee /etc/systemd/system/ke-record.service > /dev/null <<'EOF'
[Unit]
Description=KE Record Download Service
Documentation=file:///opt/ke-record/使用说明.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ke-record/record-service
ExecStart=/usr/bin/node /opt/ke-record/record-service/server.js

Environment=NODE_ENV=production
Environment=RECORD_PORT=3001
Environment=RECORD_DIR=/opt/ke-record/record-service/downloads
Environment=RECORD_TZ=0
Environment=RECORD_CONCURRENCY=2

Restart=always
RestartSec=5

StandardOutput=append:/opt/ke-record/record-service/logs/stdout.log
StandardError=append:/opt/ke-record/record-service/logs/stderr.log

# 简单加固（可选）
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
```

> **`ExecStart` 里的 node 路径**：用 `which node` 确认真实路径。
> NodeSource 装的在 `/usr/bin/node`；官方 tar 包装的在 `/usr/local/bin/node`。

### 3.3 启动并验证

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ke-record
sudo systemctl status ke-record

# 验证
curl -s http://localhost:3001/health
```

期望输出：

```json
{
  "success": true,
  "service": "record-service",
  "port": 3001,
  "ffmpegAvailable": true
}
```

`ffmpegAvailable: true` 即环境就绪。

### 3.4 常用命令

```bash
sudo systemctl restart ke-record    # 重启
sudo systemctl stop    ke-record    # 停止
sudo systemctl start   ke-record    # 启动
sudo journalctl -u ke-record -f     # 实时看日志
tail -f /opt/ke-record/record-service/logs/stderr.log
```

---

## 四、部署方案 B：装完整套件（四个服务）

对应 **ke-camera-suite** 包。

### 4.1 目录规划

```
/opt/ke-camera/
├── webrtc-streamer/     服务① 实时播放  :8000
├── onvif-ptz/           服务② 云台控制  :3000
└── record-service/      服务③ 录像下载  :3001
```

```bash
sudo mkdir -p /opt/ke-camera
sudo cp -r webrtc-streamer onvif-ptz record-service /opt/ke-camera/
sudo mkdir -p /opt/ke-camera/{webrtc-streamer,onvif-ptz,record-service}/logs
sudo mkdir -p /opt/ke-camera/record-service/downloads
```

### 4.2 服务①：webrtc-streamer（需下载 Linux 版）

Windows 包里的是 `.exe`，**不能用**。去官方 releases 下 Linux 版：

<https://github.com/mpromonet/webrtc-streamer/releases>

```bash
cd /tmp
# 下载 Linux x86_64 版（版本号按实际最新调整）
# 例如: webrtc-streamer-v0.8.20-Linux-x86_64-Release.tar.gz
tar -xzf webrtc-streamer-*.tar.gz -C /opt/ke-camera/webrtc-streamer --strip-components=1

# 检查依赖是否齐全
ldd /opt/ke-camera/webrtc-streamer/bin/webrtc-streamer | grep "not found"
```

缺库就装（常见的是 libssl、libavcodec 等）：

```bash
# Debian/Ubuntu
sudo apt install -y libssl3 libavcodec-dev libavformat-dev libavutil-dev

# 手动验证能否启动
/opt/ke-camera/webrtc-streamer/bin/webrtc-streamer -H 0.0.0.0:8000 -S -R 49152:65535
```

启动参数和 Windows 版完全一致。

### 4.3 服务②：onvif-ptz

```bash
cd /opt/ke-camera/onvif-ptz
sudo npm install --omit=dev
```

> **不要**直接搬 Windows 包的 `node_modules`——里面可能有平台相关的编译产物。
> Linux 上重新 `npm install` 最稳（几分钟，包很小）。

### 4.4 服务③：record-service

```bash
# 零依赖，不需要 npm install
sudo mkdir -p /opt/ke-camera/record-service/{logs,downloads}
```

### 4.5 四个 systemd unit

**① `ke-webrtc.service`**

```bash
sudo tee /etc/systemd/system/ke-webrtc.service > /dev/null <<'EOF'
[Unit]
Description=KE WebRTC Streamer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ke-camera/webrtc-streamer
ExecStart=/opt/ke-camera/webrtc-streamer/bin/webrtc-streamer -H 0.0.0.0:8000 -S -R 49152:65535
Restart=always
RestartSec=5
StandardOutput=append:/opt/ke-camera/webrtc-streamer/logs/stdout.log
StandardError=append:/opt/ke-camera/webrtc-streamer/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
```

**② `ke-ptz.service`**

```bash
sudo tee /etc/systemd/system/ke-ptz.service > /dev/null <<'EOF'
[Unit]
Description=KE ONVIF PTZ Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ke-camera/onvif-ptz
ExecStart=/usr/bin/node /opt/ke-camera/onvif-ptz/server.js
Restart=always
RestartSec=5
StandardOutput=append:/opt/ke-camera/onvif-ptz/logs/stdout.log
StandardError=append:/opt/ke-camera/onvif-ptz/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
```

**③ `ke-record.service`**

```bash
sudo tee /etc/systemd/system/ke-record.service > /dev/null <<'EOF'
[Unit]
Description=KE Record Download Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ke-camera/record-service
ExecStart=/usr/bin/node /opt/ke-camera/record-service/server.js
Environment=RECORD_PORT=3001
Environment=RECORD_DIR=/opt/ke-camera/record-service/downloads
Environment=RECORD_TZ=0
Restart=always
RestartSec=5
StandardOutput=append:/opt/ke-camera/record-service/logs/stdout.log
StandardError=append:/opt/ke-camera/record-service/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
```

**④ `ke-web.service`（网页调试台，8080）**

```bash
sudo tee /etc/systemd/system/ke-web.service > /dev/null <<'EOF'
[Unit]
Description=KE Web Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/ke-camera
ExecStart=/usr/bin/node /opt/ke-camera/web/server.js --no-open
Restart=always
RestartSec=5
StandardOutput=append:/opt/ke-camera/web-console.log
StandardError=append:/opt/ke-camera/web-console.log

[Install]
WantedBy=multi-user.target
EOF
```

### 4.6 启动全部

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ke-webrtc ke-ptz ke-record ke-web

# 查看状态
systemctl status ke-webrtc --no-pager
systemctl status ke-ptz    --no-pager
systemctl status ke-record --no-pager
systemctl status ke-web    --no-pager
```

### 4.7 验证

```bash
curl -s http://localhost:8000/          # webrtc-streamer 页面
curl -s http://localhost:3000/health    # 云台服务
curl -s http://localhost:3001/health    # 下载服务
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/   # 调试台
```

---

## 五、一键脚本

包内 `linux/` 目录提供了 `install.sh`，自动完成放置文件 + 生成 systemd + 启动。

**独立包：**

```bash
cd /path/to/ke-record-standalone
sudo bash linux/install.sh
```

**完整套件：**

```bash
cd /path/to/ke-camera-suite
sudo bash linux/install.sh
```

脚本会自动探测 `node` 路径、创建目录、写 unit、reload、启动、打印状态。

卸载：

```bash
sudo bash linux/uninstall.sh
```

---

## 六、防火墙

**ufw（Debian / Ubuntu）**

```bash
sudo ufw allow 3001/tcp            # 录像下载
sudo ufw allow 3000/tcp            # 云台控制（完整套件）
sudo ufw allow 8000/tcp            # 实时播放（完整套件）
sudo ufw allow 3478/tcp            # STUN
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp     # WebRTC 媒体端口
sudo ufw reload
```

**firewalld（CentOS / RHEL / Rocky）**

```bash
sudo firewall-cmd --permanent --add-port=3001/tcp
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --permanent --add-port=8000/tcp
sudo firewall-cmd --permanent --add-port=3478/tcp
sudo firewall-cmd --permanent --add-port=3478/udp
sudo firewall-cmd --permanent --add-port=49152-65535/udp
sudo firewall-cmd --reload
```

**生产环境建议限定网段**，例如 ufw：

```bash
sudo ufw allow from 192.168.110.0/24 to any port 3001 proto tcp
```

---

## 七、可选：Nginx 反向代理

如果要用域名访问、或给前端统一入口：

```nginx
server {
    listen 80;
    server_name camera.example.com;

    # 录像下载服务
    location /api/record/ {
        proxy_pass http://127.0.0.1:3001/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        client_max_body_size 0;
        proxy_read_timeout 3600s;      # 长区间下载耗时长
        proxy_buffering off;
    }

    # 云台控制
    location /api/ptz/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_set_header Host $host;
    }

    # WebRTC 信令（注意: WebRTC 媒体走 UDP，不能只靠 Nginx 转发）
    location /webrtc/ {
        proxy_pass http://127.0.0.1:8000/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

> ⚠️ **WebRTC 的媒体流走 UDP，Nginx 只能代理信令。** 要在 HTTPS 站点里用 WebRTC，
> 建议给 webrtc-streamer 配 HTTPS 证书直接访问，或用 TURN 服务。

---

## 八、常见问题

**`systemctl status` 显示 `Active: activating (auto-restart)` 反复重启？**

```bash
sudo journalctl -u ke-record -n 50 --no-pager
```

多半是端口被占或 node 路径不对：

```bash
ss -lntp | grep 3001
which node
```

**`ffmpegAvailable: false`？**

```bash
which ffmpeg          # 应有输出
sudo -u root which ffmpeg   # systemd 用的是 root 环境
```

没装就 `apt install ffmpeg`。装了还找不到，在 unit 里显式指定：

```ini
Environment=FFMPEG_PATH=/usr/bin/ffmpeg
```

**连不上摄像头？**

```bash
# 从服务器上测设备可达性
ping -c 2 192.168.110.11
curl -v --max-time 5 http://192.168.110.11/ISAPI/System/deviceInfo
```

注意 `isapiPort`：海康的 **ISAPI 与 ONVIF 共用同一个 HTTP 端口**（出厂默认 80），填成和 ONVIF 端口一致即可。

**下载大文件超时？**

Nginx 反代时记得加：

```nginx
proxy_read_timeout 3600s;
proxy_buffering off;
client_max_body_size 0;
```

**SELinux 阻止服务访问文件？**

```bash
sudo ausearch -m avc -ts recent        # 看是否被拦
sudo setsebool -P httpd_can_network_connect 1
# 或临时放行
sudo chcon -Rt var_t /opt/ke-camera
```

---

## 九、和 Windows 版的对照表

| 项目 | Windows | Linux |
|---|---|---|
| 服务管理 | NSSM + `services.msc` | **systemd** |
| Node 运行时 | 包内 `nodejs\node.exe` | 系统安装 `/usr/bin/node` |
| ffmpeg | 包内 `tools\ffmpeg.exe` | `apt install ffmpeg` → `/usr/bin/ffmpeg` |
| 防火墙 | `netsh advfirewall` | `ufw` / `firewalld` |
| 日志 | `<服务目录>\logs\*.log` | `journalctl -u <服务名>` 或同目录 `logs/` |
| 开机自启 | NSSM `SERVICE_AUTO_START` | `systemctl enable` |
| 崩溃重启 | NSSM `AppExit Restart` | `Restart=always` |
| 安装脚本 | `install-service.bat` | `linux/install.sh` |

**业务代码完全一致** —— 同一份 `server.js`、`isapi.js`、`ffmpeg.js`，两个平台跑的是同一个逻辑。
