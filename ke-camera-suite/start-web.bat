@echo off
chcp 936 >nul
cd /d "%~dp0"
title 摄像头调试台 - 关闭本窗口即停止

echo ============================================
echo   摄像头调试台
echo ============================================
echo.
echo  正在启动本地网页服务...
echo  浏览器打开 http://localhost:8080
echo.
echo  关闭本窗口即停止服务。
echo.

REM ---- Node.js：本机环境优先，包内自带兜底 ----
call "%~dp0_find-node.bat"
if not defined NODE_EXE (
    echo  [错误] 未找到 Node.js 运行时
    echo.
    echo         请安装 Node.js 18 或更高版本,
    echo         或把 node.exe 放到 %~dp0nodejs\node.exe
    echo.
    pause
    exit /b 1
)
echo  使用 Node.js %NODE_VER%, 来源: %NODE_SRC%
echo.

REM switch to UTF-8 so the node service banner shows correctly
chcp 65001 >nul
"%NODE_EXE%" "%~dp0web\server.js"
chcp 936 >nul

echo.
echo 服务已退出.
pause
