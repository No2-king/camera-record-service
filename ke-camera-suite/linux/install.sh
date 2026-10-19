#!/usr/bin/env bash
# ============================================================
#  摄像头服务套件 —— Linux 一键安装（四个服务）
#
#  用法:  sudo bash linux/install.sh
#
#  服务:
#     ke-webrtc   :8000   实时播放  (webrtc-streamer)
#     ke-ptz      :3000   云台控制  (Node + onvif)
#     ke-record   :3001   录像下载  (Node, 零依赖)
#     ke-web      :8080   网页调试台 (Node, 零依赖)
#
#  特性:
#   · 就地部署 —— 包放在哪就在哪跑
#   · 自动探测 node / ffmpeg, 自动 npm install
#   · 自动生成四个 systemd 服务并开机自启
# ============================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "[错误] 需要 root 权限, 请用: sudo bash $0"
    exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

STREAMER_DIR="${ROOT}/webrtc-streamer"
STREAMER_BIN="${STREAMER_DIR}/bin/webrtc-streamer"
PTZ_DIR="${ROOT}/onvif-ptz"
REC_DIR="${ROOT}/record-service"

echo "============================================"
echo "  摄像头服务套件 - Linux 安装"
echo "============================================"
echo "  包目录 : ${ROOT}"
echo

# ---------- 环境检查 ----------
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
    echo "[错误] 未找到 node, 请先安装 Node.js 18+"
    echo "       Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
    echo "       CentOS/RHEL  : curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo dnf install -y nodejs"
    exit 1
fi
echo "[OK] node    : ${NODE_BIN}  ($("${NODE_BIN}" -v))"

NPM_BIN="$(command -v npm || true)"
[[ -n "${NPM_BIN}" ]] && echo "[OK] npm     : ${NPM_BIN}"

FFMPEG_BIN="$(command -v ffmpeg || true)"
if [[ -z "${FFMPEG_BIN}" ]]; then
    echo "[警告] 未找到 ffmpeg, 录像下载功能将不可用"
    echo "       Ubuntu/Debian: sudo apt install -y ffmpeg"
    echo "       CentOS/RHEL  : sudo dnf install -y epel-release ffmpeg"
else
    echo "[OK] ffmpeg  : ${FFMPEG_BIN}"
fi
echo

# ============================================================
#  服务①  webrtc-streamer
# ============================================================
echo "--------------------------------------------"
echo " [1/4] webrtc-streamer  (:8000)"
echo "--------------------------------------------"

HAVE_STREAMER=0
if [[ -x "${STREAMER_BIN}" ]]; then
    HAVE_STREAMER=1
    echo "[OK] 找到 ${STREAMER_BIN}"
elif [[ -f "${STREAMER_DIR}/bin/webrtc-streamer.exe" ]]; then
    echo "[警告] 只有 Windows 版 (webrtc-streamer.exe), Linux 不能用"
    echo "       请从下面地址下载 Linux x86_64 版并解压到: ${STREAMER_DIR}/"
    echo "       https://github.com/mpromonet/webrtc-streamer/releases"
    echo "       解压后应存在: ${STREAMER_BIN}"
else
    echo "[警告] 未找到 webrtc-streamer, 跳过该服务"
    echo "       下载地址: https://github.com/mpromonet/webrtc-streamer/releases"
fi

if [[ "${HAVE_STREAMER}" -eq 1 ]]; then
    mkdir -p "${STREAMER_DIR}/logs"
    MISSING="$(ldd "${STREAMER_BIN}" 2>/dev/null | grep "not found" || true)"
    [[ -n "${MISSING}" ]] && { echo "[警告] 缺少动态库:"; echo "${MISSING}"; }
fi
echo

# ============================================================
#  服务②  onvif-ptz
# ============================================================
echo "--------------------------------------------"
echo " [2/4] onvif-ptz  (:3000)"
echo "--------------------------------------------"

[[ -f "${PTZ_DIR}/server.js" ]] || { echo "[错误] 缺少 ${PTZ_DIR}/server.js"; exit 1; }

mkdir -p "${PTZ_DIR}/logs"

if [[ ! -d "${PTZ_DIR}/node_modules/express" ]]; then
    if [[ -z "${NPM_BIN}" ]]; then
        echo "[错误] 缺少依赖且找不到 npm, 无法安装"
        exit 1
    fi
    echo "正在安装依赖 (npm install)..."
    ( cd "${PTZ_DIR}" && "${NPM_BIN}" install --omit=dev --no-audit --no-fund )
    echo "[OK] 依赖安装完成"
else
    echo "[OK] 依赖已存在 (node_modules/express)"
fi
echo

# ============================================================
#  服务③  record-service
# ============================================================
echo "--------------------------------------------"
echo " [3/4] record-service  (:3001)"
echo "--------------------------------------------"

[[ -f "${REC_DIR}/server.js" ]] || { echo "[错误] 缺少 ${REC_DIR}/server.js"; exit 1; }
mkdir -p "${REC_DIR}/logs" "${REC_DIR}/downloads"
echo "[OK] 目录准备完成 (零依赖, 无需 npm install)"
echo

# ============================================================
#  生成 systemd unit
# ============================================================
echo "--------------------------------------------"
echo " 生成 systemd 服务"
echo "--------------------------------------------"

if [[ "${HAVE_STREAMER}" -eq 1 ]]; then
    cat > /etc/systemd/system/ke-webrtc.service <<EOF
[Unit]
Description=KE WebRTC Streamer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${STREAMER_DIR}
ExecStart=${STREAMER_BIN} -H 0.0.0.0:8000 -S -R 49152:65535
Restart=always
RestartSec=5
StandardOutput=append:${STREAMER_DIR}/logs/stdout.log
StandardError=append:${STREAMER_DIR}/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
    echo "[OK] /etc/systemd/system/ke-webrtc.service"
fi

cat > /etc/systemd/system/ke-ptz.service <<EOF
[Unit]
Description=KE ONVIF PTZ Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PTZ_DIR}
ExecStart=${NODE_BIN} ${PTZ_DIR}/server.js
Restart=always
RestartSec=5
StandardOutput=append:${PTZ_DIR}/logs/stdout.log
StandardError=append:${PTZ_DIR}/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
echo "[OK] /etc/systemd/system/ke-ptz.service"

cat > /etc/systemd/system/ke-record.service <<EOF
[Unit]
Description=KE Record Download Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REC_DIR}
ExecStart=${NODE_BIN} ${REC_DIR}/server.js
Environment=RECORD_PORT=3001
Environment=RECORD_DIR=${REC_DIR}/downloads
Environment=RECORD_TZ=0
Restart=always
RestartSec=5
StandardOutput=append:${REC_DIR}/logs/stdout.log
StandardError=append:${REC_DIR}/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF
echo "[OK] /etc/systemd/system/ke-record.service"
echo

cat > /etc/systemd/system/ke-web.service <<EOF
[Unit]
Description=KE Web Console
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${ROOT}
ExecStart=${NODE_BIN} ${ROOT}/web/server.js --no-open
Restart=always
RestartSec=5
StandardOutput=append:${ROOT}/web-console.log
StandardError=append:${ROOT}/web-console.log

[Install]
WantedBy=multi-user.target
EOF
echo "[OK] /etc/systemd/system/ke-web.service"
echo

# ============================================================
#  启动
# ============================================================
systemctl daemon-reload

if [[ "${HAVE_STREAMER}" -eq 1 ]]; then
    systemctl enable --now ke-webrtc
fi
systemctl enable --now ke-ptz
systemctl enable --now ke-record
systemctl enable --now ke-web

sleep 2

echo "============================================"
echo "  服务状态"
echo "============================================"
if [[ "${HAVE_STREAMER}" -eq 1 ]]; then
    systemctl status ke-webrtc --no-pager | head -5 || true
    echo
fi
systemctl status ke-ptz    --no-pager | head -5 || true
echo
systemctl status ke-record --no-pager | head -5 || true
echo
systemctl status ke-web    --no-pager | head -5 || true
echo

echo "============================================"
echo "  安装完成"
echo "============================================"
[[ "${HAVE_STREAMER}" -eq 1 ]] && echo "  实时播放   : http://localhost:8000"
echo "  云台健康   : http://localhost:3000/health"
echo "  下载首页   : http://localhost:3001"
echo "  下载健康   : http://localhost:3001/health"
echo "  调试台     : http://localhost:8080"
echo
echo "  管理命令:"
[[ "${HAVE_STREAMER}" -eq 1 ]] && echo "    systemctl restart ke-webrtc"
echo "    systemctl restart ke-ptz"
echo "    systemctl restart ke-record"
echo "    systemctl restart ke-web"
echo
echo "  防火墙 (局域网访问需要):"
echo "    sudo ufw allow 8000/tcp 3000/tcp 3001/tcp 8080/tcp 3478/tcp 3478/udp"
echo "    sudo ufw allow 49152:65535/udp"
echo
