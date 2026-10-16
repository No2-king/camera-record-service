@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 摄像头调试台 - 关闭本窗口即停止

echo ============================================
echo   摄像头调试台
echo ============================================
echo.
echo  正在启动本地网页服务...
echo  浏览器会自动打开 http://localhost:8080
echo.
echo  关闭本窗口即停止服务。
echo.

"%~dp0nodejs\node.exe" "%~dp0web\server.js"

echo.
echo 服务已退出.
pause
