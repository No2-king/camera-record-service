@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
REM ============================================================
REM  摄像头服务套件 —— 一键注册三个 Windows 服务
REM
REM    1. KE-WebRTCStreamer   实时播放   (webrtc-streamer)   端口 8000
REM    2. KE-OnvifPtzService  云台控制   (node server.js)    端口 3000
REM    3. KE-RecordService    录像下载   (node server.js)    端口 3001
REM
REM  请以【管理员身份】运行本脚本
REM ============================================================

REM ---- 管理员权限检查 ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 请选择"以管理员身份运行"执行本脚本!
    echo.
    pause
    exit /b 1
)

REM ---- 以本脚本所在目录为根目录 ----
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NSSM_EXE=%ROOT%\nssm\nssm.exe"
set "NODE_EXE=%ROOT%\nodejs\node.exe"

set "STREAMER_DIR=%ROOT%\webrtc-streamer"
set "STREAMER_EXE=%ROOT%\webrtc-streamer\bin\webrtc-streamer.exe"

set "PTZ_DIR=%ROOT%\onvif-ptz"
set "PTZ_SCRIPT=%ROOT%\onvif-ptz\server.js"

set "REC_DIR=%ROOT%\record-service"
set "REC_SCRIPT=%ROOT%\record-service\server.js"

set "FFMPEG_EXE=%ROOT%\tools\ffmpeg.exe"
set "CONFIG_FILE=%ROOT%\config.json"

set "STREAMER_SVC=KE-WebRTCStreamer"
set "PTZ_SVC=KE-OnvifPtzService"
set "REC_SVC=KE-RecordService"

REM ---- 是否使用 config.json 预注册摄像头 ----
REM  0 = 动态模式 (默认) : RTSP 地址由前端传入
REM  1 = 预注册模式      : 从 config.json 读取固定摄像头地址
set "USE_CONFIG=0"

REM ---- webrtc-streamer 启动参数 ----
set "STREAMER_ARGS=-H 0.0.0.0:8000 -S -R 49152:65535 -o"
if "%USE_CONFIG%"=="1" set "STREAMER_ARGS=%STREAMER_ARGS% -C ""%CONFIG_FILE%"""

echo ============================================
echo   摄像头服务套件 - 安装
echo ============================================
echo.
echo  根目录   : %ROOT%
echo  预注册   : %USE_CONFIG%  (0=动态 1=预注册)
echo.

REM ============================================================
REM  前置检查
REM ============================================================
echo [1/5] 前置检查...

if not exist "%NSSM_EXE%"     ( echo   [错误] 找不到 NSSM: %NSSM_EXE% & pause & exit /b 1 )
if not exist "%NODE_EXE%"     ( echo   [错误] 找不到 node.exe: %NODE_EXE% & pause & exit /b 1 )
if not exist "%STREAMER_EXE%" ( echo   [错误] 找不到 webrtc-streamer.exe: %STREAMER_EXE% & pause & exit /b 1 )
if not exist "%PTZ_SCRIPT%"   ( echo   [错误] 找不到 onvif-ptz\server.js & pause & exit /b 1 )
if not exist "%REC_SCRIPT%"   ( echo   [错误] 找不到 record-service\server.js & pause & exit /b 1 )

if not exist "%PTZ_DIR%\node_modules" (
    echo   [错误] onvif-ptz 依赖未安装
    echo          请执行: cd /d "%PTZ_DIR%" ^&^& "..\nodejs\npm.cmd" install
    pause & exit /b 1
)

if not exist "%REC_DIR%\logs" mkdir "%REC_DIR%\logs" >nul 2>&1
if not exist "%STREAMER_DIR%\logs" mkdir "%STREAMER_DIR%\logs" >nul 2>&1
if not exist "%PTZ_DIR%\logs" mkdir "%PTZ_DIR%\logs" >nul 2>&1
if not exist "%REC_DIR%\downloads" mkdir "%REC_DIR%\downloads" >nul 2>&1

echo   [OK] 检查通过
echo.

REM ============================================================
REM  ffmpeg 检查
REM ============================================================
echo [2/5] 检查 ffmpeg...

if not exist "%FFMPEG_EXE%" (
    echo   [警告] 未找到 %FFMPEG_EXE%
    echo          录像下载功能将不可用, 其余两个服务不受影响
    echo.
    goto :ffmpeg_done
)
echo   [OK] %FFMPEG_EXE%
echo.

:ffmpeg_done

REM ============================================================
REM  注册 ffmpeg 到系统环境变量
REM ============================================================
echo [3/5] 注册 ffmpeg 环境变量...

if not exist "%FFMPEG_EXE%" (
    echo   [跳过] ffmpeg 不存在
    echo.
    goto :env_done
)

setx /M FFMPEG_PATH "%FFMPEG_EXE%" >nul 2>&1
if errorlevel 1 (
    echo   [警告] 系统环境变量写入失败, 不影响服务运行
    echo          三个服务均已单独配置 FFMPEG_PATH
) else (
    echo   [OK] FFMPEG_PATH = %FFMPEG_EXE%
)
echo.

:env_done

REM ============================================================
REM  清理同名旧服务
REM ============================================================
"%NSSM_EXE%" stop   %STREAMER_SVC% >nul 2>&1
"%NSSM_EXE%" remove %STREAMER_SVC% confirm >nul 2>&1
"%NSSM_EXE%" stop   %PTZ_SVC%      >nul 2>&1
"%NSSM_EXE%" remove %PTZ_SVC%      confirm >nul 2>&1
"%NSSM_EXE%" stop   %REC_SVC%      >nul 2>&1
"%NSSM_EXE%" remove %REC_SVC%      confirm >nul 2>&1

REM ============================================================
REM  注册三个服务
REM ============================================================
echo [4/5] 注册服务...

echo   1) %STREAMER_SVC%  (实时播放 :8000)
"%NSSM_EXE%" install %STREAMER_SVC% "%STREAMER_EXE%"
"%NSSM_EXE%" set %STREAMER_SVC% AppParameters "%STREAMER_ARGS%"
"%NSSM_EXE%" set %STREAMER_SVC% AppDirectory  "%STREAMER_DIR%"
"%NSSM_EXE%" set %STREAMER_SVC% AppStdout     "%STREAMER_DIR%\logs\stdout.log"
"%NSSM_EXE%" set %STREAMER_SVC% AppStderr     "%STREAMER_DIR%\logs\stderr.log"
"%NSSM_EXE%" set %STREAMER_SVC% AppStdoutCreationDisposition 4
"%NSSM_EXE%" set %STREAMER_SVC% AppStderrCreationDisposition 4
"%NSSM_EXE%" set %STREAMER_SVC% AppRotateFiles 1
"%NSSM_EXE%" set %STREAMER_SVC% AppRotateBytes 10485760
"%NSSM_EXE%" set %STREAMER_SVC% Start SERVICE_AUTO_START
"%NSSM_EXE%" set %STREAMER_SVC% AppExit Default Restart
"%NSSM_EXE%" set %STREAMER_SVC% AppRestartDelay 5000
"%NSSM_EXE%" set %STREAMER_SVC% AppThrottle 5000
"%NSSM_EXE%" set %STREAMER_SVC% AppStopMethodConsole 15000
echo      [OK]

echo   2) %PTZ_SVC%  (云台控制 :3000)
"%NSSM_EXE%" install %PTZ_SVC% "%NODE_EXE%"
"%NSSM_EXE%" set %PTZ_SVC% AppParameters "\"%PTZ_SCRIPT%\""
"%NSSM_EXE%" set %PTZ_SVC% AppDirectory  "%PTZ_DIR%"
"%NSSM_EXE%" set %PTZ_SVC% AppStdout     "%PTZ_DIR%\logs\stdout.log"
"%NSSM_EXE%" set %PTZ_SVC% AppStderr     "%PTZ_DIR%\logs\stderr.log"
"%NSSM_EXE%" set %PTZ_SVC% AppStdoutCreationDisposition 4
"%NSSM_EXE%" set %PTZ_SVC% AppStderrCreationDisposition 4
"%NSSM_EXE%" set %PTZ_SVC% AppRotateFiles 1
"%NSSM_EXE%" set %PTZ_SVC% AppRotateBytes 10485760
"%NSSM_EXE%" set %PTZ_SVC% Start SERVICE_AUTO_START
"%NSSM_EXE%" set %PTZ_SVC% AppExit Default Restart
"%NSSM_EXE%" set %PTZ_SVC% AppRestartDelay 5000
"%NSSM_EXE%" set %PTZ_SVC% AppThrottle 5000
"%NSSM_EXE%" set %PTZ_SVC% AppStopMethodConsole 15000
echo      [OK]

echo   3) %REC_SVC%  (录像下载 :3001)
"%NSSM_EXE%" install %REC_SVC% "%NODE_EXE%"
"%NSSM_EXE%" set %REC_SVC% AppParameters "\"%REC_SCRIPT%\""
"%NSSM_EXE%" set %REC_SVC% AppDirectory  "%REC_DIR%"
"%NSSM_EXE%" set %REC_SVC% AppStdout     "%REC_DIR%\logs\stdout.log"
"%NSSM_EXE%" set %REC_SVC% AppStderr     "%REC_DIR%\logs\stderr.log"
"%NSSM_EXE%" set %REC_SVC% AppStdoutCreationDisposition 4
"%NSSM_EXE%" set %REC_SVC% AppStderrCreationDisposition 4
"%NSSM_EXE%" set %REC_SVC% AppRotateFiles 1
"%NSSM_EXE%" set %REC_SVC% AppRotateBytes 10485760
"%NSSM_EXE%" set %REC_SVC% AppEnvironmentExtra "FFMPEG_PATH=%FFMPEG_EXE%"
"%NSSM_EXE%" set %REC_SVC% Start SERVICE_AUTO_START
"%NSSM_EXE%" set %REC_SVC% AppExit Default Restart
"%NSSM_EXE%" set %REC_SVC% AppRestartDelay 5000
"%NSSM_EXE%" set %REC_SVC% AppThrottle 5000
"%NSSM_EXE%" set %REC_SVC% AppStopMethodConsole 15000
echo      [OK]
echo.

REM ============================================================
REM  启动服务
REM ============================================================
echo [5/5] 启动服务...
"%NSSM_EXE%" start %STREAMER_SVC%
"%NSSM_EXE%" start %PTZ_SVC%
"%NSSM_EXE%" start %REC_SVC%
echo.
ping -n 5 127.0.0.1 >nul 2>&1

echo ============================================
echo   安装完成 - 服务状态
echo ============================================
"%NSSM_EXE%" status %STREAMER_SVC%
echo.
"%NSSM_EXE%" status %PTZ_SVC%
echo.
"%NSSM_EXE%" status %REC_SVC%
echo.
echo ============================================
echo   访问地址
echo ============================================
echo   实时播放       : http://localhost:8000
echo   云台控制健康   : http://localhost:3000/health
echo   录像下载首页   : http://localhost:3001
echo   下载健康检查   : http://localhost:3001/health
echo.
echo   提示: 外部浏览器访问不了, 请以管理员身份运行
echo         firewall-rules.bat 放行端口.
echo.
echo   管理命令:
echo     nssm restart %STREAMER_SVC%
echo     nssm restart %PTZ_SVC%
echo     nssm restart %REC_SVC%
echo.
pause
