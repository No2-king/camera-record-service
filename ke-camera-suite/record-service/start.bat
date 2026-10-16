@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 录像下载服务 - 调试模式
echo ============================================
echo   录像下载服务 - 前台调试模式
echo ============================================
echo.
echo  端口 3001    按 Ctrl+C 停止
echo.
echo  浏览器打开 http://localhost:3001 查看状态
echo.
"..\nodejs\node.exe" server.js
echo.
echo 服务已退出.
pause
