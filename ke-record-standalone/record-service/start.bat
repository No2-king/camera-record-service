@echo off
chcp 936 >nul
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

REM ---- Node.js：本机环境优先，包内自带兜底 ----
call "%~dp0..\_find-node.bat"
if not defined NODE_EXE (
    echo  [错误] 未找到 Node.js 运行时
    echo.
    echo         请安装 Node.js 18 或更高版本,
    echo         或把 node.exe 放到 %~dp0..\nodejs\node.exe
    echo.
    pause
    exit /b 1
)
echo  使用 Node.js %NODE_VER%, 来源: %NODE_SRC%
echo.

REM switch to UTF-8 so the node service banner shows correctly
chcp 65001 >nul
"%NODE_EXE%" server.js
chcp 936 >nul

echo.
echo 服务已退出.
pause
