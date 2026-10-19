@echo off
chcp 936 >nul
setlocal
REM ============================================================
REM  录像下载服务（独立包）—— 卸载
REM
REM  只删除服务注册与环境变量, 不删除任何程序文件.
REM  请【以管理员身份运行】.
REM ============================================================

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 请右键选择"以管理员身份运行"执行本脚本！
    echo.
    pause
    exit /b 1
)

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NSSM_EXE=%ROOT%\nssm\nssm.exe"
set "REC_SVC=KE-RecordService"
set "WEB_SVC=KE-WebConsole"

echo ============================================
echo   卸载录像下载服务
echo ============================================
echo.

if not exist "%NSSM_EXE%" (
    echo [错误] 找不到 NSSM: %NSSM_EXE%
    pause
    exit /b 1
)

echo [1/3] 停止并删除 %REC_SVC%...
"%NSSM_EXE%" stop   %REC_SVC% >nul 2>&1
"%NSSM_EXE%" remove %REC_SVC% confirm >nul 2>&1
echo       [OK]
echo.

echo [2/3] 停止并删除 %WEB_SVC%...
"%NSSM_EXE%" stop   %WEB_SVC% >nul 2>&1
"%NSSM_EXE%" remove %WEB_SVC% confirm >nul 2>&1
echo       [OK]
echo.


echo [3/3] 清除 FFMPEG_PATH 环境变量...
reg delete "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /F /V FFMPEG_PATH >nul 2>&1
if errorlevel 1 (
    echo       [跳过] 未设置或删除失败
) else (
    echo       [OK] 已删除
)
echo.

echo ============================================
echo   卸载完成 (程序文件未删除)
echo ============================================
echo   想彻底清理, 直接删除整个文件夹即可.
echo.
pause
