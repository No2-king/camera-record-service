#!/usr/bin/env bash
# ============================================================
#  录像下载服务（独立包）—— Linux 一键安装
#
#  用法:  sudo bash linux/install.sh
#
#  特性:
#   · 就地部署 —— 包放在哪就在哪跑, 不需要移动文件
#   · 自动探测 node / ffmpeg
#   · 自动生成两个 systemd 服务（ke-record + ke-web）并开机自启
# ============================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "[错误] 需要 root 权限, 请用: sudo bash $0"
    exit 1
fi

# 包根目录 = 本脚本所在目录的上一级
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REC_DIR="${ROOT}/record-service"
SVC_NAME="ke-record"
UNIT="/etc/systemd/system/${SVC_NAME}.service"
PORT="${RECORD_PORT:-3001}"

echo "============================================"
echo "  录像下载服务 - Linux 安装"
echo "============================================"
echo "  包目录 : ${ROOT}"
echo "  端口   : ${PORT}"
echo

# ---------- 检查 node ----------
NODE_BIN="$(command -v node || true)"
if [[ -z "${NODE_BIN}" ]]; then
    echo "[错误] 未找到 node, 请先安装 Node.js 18+"
    echo
    echo "  Ubuntu/Debian:"
    echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "    sudo apt install -y nodejs"
    echo
    echo "  CentOS/RHEL/Rocky:"
    echo "    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -"
    echo "    sudo dnf install -y nodejs"
    exit 1
fi
echo "[OK] node    : ${NODE_BIN}  ($("${NODE_BIN}" -v))"

# ---------- 检查 ffmpeg ----------
FFMPEG_BIN="$(command -v ffmpeg || true)"
if [[ -z "${FFMPEG_BIN}" ]]; then
    echo "[警告] 未找到 ffmpeg, 下载功能将不可用"
    echo "       Ubuntu/Debian: sudo apt install -y ffmpeg"
    echo "       CentOS/RHEL  : sudo dnf install -y epel-release ffmpeg"
else
    echo "[OK] ffmpeg  : ${FFMPEG_BIN}"
fi

# ---------- 检查服务文件 ----------
[[ -f "${REC_DIR}/server.js"      ]] || { echo "[错误] 缺少 ${REC_DIR}/server.js";      exit 1; }
[[ -f "${REC_DIR}/lib/isapi.js"   ]] || { echo "[错误] 缺少 ${REC_DIR}/lib/isapi.js";   exit 1; }
[[ -f "${REC_DIR}/lib/ffmpeg.js"  ]] || { echo "[错误] 缺少 ${REC_DIR}/lib/ffmpeg.js";  exit 1; }

mkdir -p "${REC_DIR}/logs" "${REC_DIR}/downloads"
echo "[OK] 目录准备完成"
echo

# ---------- 生成 systemd unit ----------
cat > "${UNIT}" <<EOF
[Unit]
Description=KE Record Download Service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REC_DIR}
ExecStart=${NODE_BIN} ${REC_DIR}/server.js
Environment=RECORD_PORT=${PORT}
Environment=RECORD_DIR=${REC_DIR}/downloads
Environment=RECORD_TZ=0
Restart=always
RestartSec=5
StandardOutput=append:${REC_DIR}/logs/stdout.log
StandardError=append:${REC_DIR}/logs/stderr.log

[Install]
WantedBy=multi-user.target
EOF

echo "[OK] 已写入 ${UNIT}"
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

# ---------- 启动 ----------
systemctl daemon-reload
systemctl enable --now "${SVC_NAME}"
systemctl enable --now ke-web
sleep 2

echo "============================================"
echo "  服务状态"
echo "============================================"
systemctl status "${SVC_NAME}" --no-pager || true
echo

echo "============================================"
echo "  安装完成"
echo "============================================"
echo "  首页     : http://localhost:${PORT}"
echo "  健康检查 : http://localhost:${PORT}/health"
echo "  成品目录 : ${REC_DIR}/downloads"
echo
echo "  管理命令:"
echo "    systemctl restart ${SVC_NAME}"
echo "    systemctl stop    ${SVC_NAME}"
echo "    systemctl start   ${SVC_NAME}"
echo "    journalctl -u ${SVC_NAME} -f"
echo
echo "  防火墙 (局域网访问需要):"
echo "    sudo ufw allow ${PORT}/tcp"
echo "    或 sudo firewall-cmd --permanent --add-port=${PORT}/tcp && sudo firewall-cmd --reload"
echo
