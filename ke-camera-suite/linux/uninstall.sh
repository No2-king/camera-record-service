#!/usr/bin/env bash
# ============================================================
#  摄像头服务套件 —— Linux 卸载
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

echo "============================================"
echo "  卸载摄像头服务套件"
echo "============================================"
echo

for SVC in ke-webrtc ke-ptz ke-record; do
    if systemctl list-unit-files | grep -q "^${SVC}.service"; then
        systemctl stop    "${SVC}" 2>/dev/null || true
        systemctl disable "${SVC}" 2>/dev/null || true
        echo "[OK] 已停止并禁用 ${SVC}"
    else
        echo "[跳过] ${SVC} 未注册"
    fi

    if [[ -f "/etc/systemd/system/${SVC}.service" ]]; then
        rm -f "/etc/systemd/system/${SVC}.service"
        echo "[OK] 已删除 /etc/systemd/system/${SVC}.service"
    fi
done

systemctl daemon-reload

echo
echo "============================================"
echo "  卸载完成 (程序文件未删除)"
echo "============================================"
echo "  想彻底清理, 直接删除整个文件夹即可."
echo
