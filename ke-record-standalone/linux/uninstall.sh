#!/usr/bin/env bash
# ============================================================
#  录像下载服务（独立包）—— Linux 卸载
#
#  用法:  sudo bash linux/uninstall.sh
#
#  只删除 systemd 服务注册, 不删除任何程序文件.
# ============================================================
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
    echo "[错误] 需要 root 权限, 请用: sudo bash $0"
    exit 1
fi

SVC_NAME="ke-record"
UNIT="/etc/systemd/system/${SVC_NAME}.service"

echo "============================================"
echo "  卸载录像下载服务"
echo "============================================"
echo

if systemctl list-unit-files | grep -q "^${SVC_NAME}.service"; then
    systemctl stop    "${SVC_NAME}" 2>/dev/null || true
    systemctl disable "${SVC_NAME}" 2>/dev/null || true
    echo "[OK] 已停止并禁用 ${SVC_NAME}"
else
    echo "[跳过] ${SVC_NAME} 未注册"
fi

if [[ -f "${UNIT}" ]]; then
    rm -f "${UNIT}"
    echo "[OK] 已删除 ${UNIT}"
fi

systemctl daemon-reload

echo
echo "============================================"
echo "  卸载完成 (程序文件未删除)"
echo "============================================"
echo "  想彻底清理, 直接删除整个文件夹即可."
echo
