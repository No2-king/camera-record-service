@echo off
chcp 936 >nul
setlocal EnableDelayedExpansion
REM ============================================================
REM  Camera service suite - register three Windows services
REM
REM    1. KE-WebRTCStreamer   live view    webrtc-streamer  :8000
REM    2. KE-OnvifPtzService  PTZ control  node server.js   :3000
REM    3. KE-RecordService    playback     node server.js   :3001
REM
REM  Usage, right-click - Run as administrator:
REM    install-service.bat          pre-check, register, start
REM    install-service.bat check    pre-check only, changes nothing
REM
REM  Node.js runtime is resolved by _find-node.bat:
REM    system PATH  ->  common install dirs  ->  bundled nodejs\node.exe
REM  so the installer works both on machines that already have Node
REM  and on machines that only carry the bundled runtime.
REM
REM  BATCH FILE RULES - please keep them, cmd.exe is fragile here:
REM    1. Comments stay ASCII-only. cmd.exe can desync its byte
REM       position on UTF-8 multi-byte comment lines and then run
REM       fragments of them as commands.
REM    2. Never put a half-width round bracket inside an echo line
REM       that sits in an if/else block. The closing bracket ends
REM       the block early and the rest leaks out as top-level
REM       commands. Use full-width brackets or a comma instead.
REM ============================================================

REM ---- argument: check mode ----
set "CHECK_ONLY=0"
if /i "%~1"=="check"  set "CHECK_ONLY=1"
if /i "%~1"=="-check" set "CHECK_ONLY=1"

REM ---- administrator check, skipped in check mode ----
if "%CHECK_ONLY%"=="0" (
    net session >nul 2>&1
    if !errorlevel! neq 0 (
        echo.
        echo [错误] 请右键选择"以管理员身份运行"执行本脚本！
        echo.
        pause
        exit /b 1
    )
)

REM ---- root = directory of this script ----
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NSSM_EXE=%ROOT%\nssm\nssm.exe"

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
set "WEB_SVC=KE-WebConsole"

REM ---- pre-register cameras from config.json? ----
REM  0 = dynamic mode, default: RTSP url comes from the front end
REM  1 = pre-registered mode   : fixed cameras read from config.json
set "USE_CONFIG=0"

REM ---- webrtc-streamer arguments ----
set "STREAMER_ARGS=-H 0.0.0.0:8000 -S -R 49152:65535 -o"
if "%USE_CONFIG%"=="1" set "STREAMER_ARGS=%STREAMER_ARGS% -C ""%CONFIG_FILE%"""

echo ============================================
echo   摄像头服务套件 - 安装
echo ============================================
echo.
echo  根目录   : %ROOT%
echo  预注册   : %USE_CONFIG%  0=动态 1=预注册
if "%CHECK_ONLY%"=="1" echo  模式     : 仅检查，不会修改系统
echo.

REM ============================================================
REM  [1/6] pre-flight check
REM ============================================================
echo [1/6] 前置检查...

if not exist "%NSSM_EXE%" (
    echo   [错误] 找不到 NSSM: %NSSM_EXE%
    pause
    exit /b 1
)

REM ---- Node.js: local machine first, bundled runtime as fallback ----
call "%ROOT%\_find-node.bat"

if not defined NODE_EXE (
    echo   [错误] 未找到 Node.js 运行时
    echo.
    echo          已按以下顺序查找, 均未命中:
    echo            1. 系统 PATH 中的 node
    echo            2. 常见安装目录, 如 Program Files\nodejs
    echo            3. 本包内 %ROOT%\nodejs\node.exe
    echo.
    echo          解决办法, 任选其一:
    echo            A. 安装 Node.js 18 或更高版本
    echo               https://nodejs.org/zh-cn/download
    echo            B. 把 node.exe 放到下面这个位置
    echo               %ROOT%\nodejs\node.exe
    echo.
    pause
    exit /b 1
)
echo   [OK] Node.js %NODE_VER%   来源: %NODE_SRC%
echo        %NODE_EXE%

if defined NODE_MAJOR (
    if !NODE_MAJOR! LSS 18 (
        echo   [警告] Node.js 版本偏低, 建议使用 18 或更高版本
    )
)

set "_NP=%NODE_EXE%"
if not "!_NP:\Users\=!"=="!_NP!" (
    echo   [提示] node 位于用户目录下, 服务以 LocalSystem 运行时可能无权读取
    echo          若服务启动失败, 请改用 Program Files 下的 Node.js
)

REM ---- webrtc-streamer is optional, skip that one service if absent ----
set "HAVE_STREAMER=1"
if not exist "%STREAMER_EXE%" (
    set "HAVE_STREAMER=0"
    echo   [警告] 未找到 webrtc-streamer.exe
    echo          %STREAMER_EXE%
    echo          将跳过 KE-WebRTCStreamer, 其余两个服务照常安装
    echo          需要实时播放时, 把 webrtc-streamer 解压到:
    echo          %STREAMER_DIR%
)

if not exist "%PTZ_SCRIPT%" (
    echo   [错误] 找不到 onvif-ptz\server.js
    pause
    exit /b 1
)
if not exist "%REC_SCRIPT%" (
    echo   [错误] 找不到 record-service\server.js
    pause
    exit /b 1
)

REM ---- onvif-ptz dependencies ----
REM  Check onvif, not just express. A half-finished npm install leaves
REM  express present but onvif missing, and the service then dies with
REM  "Cannot find module 'onvif'". That is exactly how a silent failure
REM  turns into a crash loop, so verify both packages.
if exist "%PTZ_DIR%\node_modules\onvif\package.json" if exist "%PTZ_DIR%\node_modules\express\package.json" (
    echo   [OK] onvif-ptz 依赖已存在
    goto :deps_done
)

if not defined NPM_CMD (
    echo   [错误] onvif-ptz 依赖未安装, 且找不到 npm
    echo          请安装完整版 Node.js, 需包含 npm, 然后执行:
    echo            cd /d "%PTZ_DIR%"
    echo            npm install
    pause
    exit /b 1
)

if "%CHECK_ONLY%"=="1" (
    echo   [警告] onvif-ptz 依赖不完整, 检查模式下不自动安装
    echo          正式安装时会自动执行 npm install
    goto :deps_done
)

echo   正在安装 onvif-ptz 依赖, 首次可能需要几分钟...
pushd "%PTZ_DIR%"
call "%NPM_CMD%" install --omit=dev --no-audit --no-fund
set "NPM_RC=!errorlevel!"
if not "!NPM_RC!"=="0" (
    echo   [提示] 默认源安装失败, 改用国内镜像 npmmirror 重试...
    call "%NPM_CMD%" install --omit=dev --no-audit --no-fund --registry=https://registry.npmmirror.com
    set "NPM_RC=!errorlevel!"
)
popd

if not "!NPM_RC!"=="0" (
    echo   [错误] npm install 失败, 退出码 !NPM_RC!
    echo          可手动执行:
    echo            cd /d "%PTZ_DIR%"
    echo            npm install --registry=https://registry.npmmirror.com
    pause
    exit /b 1
)
if not exist "%PTZ_DIR%\node_modules\onvif\package.json" (
    echo   [错误] 安装完成但仍缺少 onvif 模块, 依赖不完整
    echo          请手动执行:
    echo            cd /d "%PTZ_DIR%"
    echo            npm install --registry=https://registry.npmmirror.com
    pause
    exit /b 1
)
echo   [OK] onvif-ptz 依赖安装完成

:deps_done

if not exist "%REC_DIR%\logs"      mkdir "%REC_DIR%\logs"      >nul 2>&1
if not exist "%STREAMER_DIR%\logs" mkdir "%STREAMER_DIR%\logs" >nul 2>&1
if not exist "%PTZ_DIR%\logs"      mkdir "%PTZ_DIR%\logs"      >nul 2>&1
if not exist "%REC_DIR%\downloads" mkdir "%REC_DIR%\downloads" >nul 2>&1

echo   [OK] 检查通过
echo.

REM ============================================================
REM  [2/6] ffmpeg
REM ============================================================
echo [2/6] 检查 ffmpeg...

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
REM  [3/6] register FFMPEG_PATH
REM ============================================================
echo [3/6] 注册 ffmpeg 环境变量...

if not exist "%FFMPEG_EXE%" (
    echo   [跳过] ffmpeg 不存在
    echo.
    goto :env_done
)
if "%CHECK_ONLY%"=="1" (
    echo   [跳过] 检查模式
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
REM  check mode stops here
REM ============================================================
if "%CHECK_ONLY%"=="1" (
    echo ============================================
    echo   检查模式 - 未做任何修改
    echo ============================================
    echo   Node.js          : %NODE_VER%   [%NODE_SRC%]
    echo   node.exe         : %NODE_EXE%
    echo   npm              : %NPM_CMD%
    echo   webrtc-streamer  : %HAVE_STREAMER%   1=可用 0=缺失
    echo   onvif-ptz        : %PTZ_DIR%
    echo   record-service   : %REC_DIR%
    echo   ffmpeg           : %FFMPEG_EXE%
    echo.
    echo   去掉 check 参数即可正式安装.
    echo.
    pause
    exit /b 0
)

REM ============================================================
REM  remove services with the same name
REM ============================================================
"%NSSM_EXE%" stop   %STREAMER_SVC% >nul 2>&1
"%NSSM_EXE%" remove %STREAMER_SVC% confirm >nul 2>&1
"%NSSM_EXE%" stop   %PTZ_SVC%      >nul 2>&1
"%NSSM_EXE%" remove %PTZ_SVC%      confirm >nul 2>&1
"%NSSM_EXE%" stop   %REC_SVC%      >nul 2>&1
"%NSSM_EXE%" remove %REC_SVC%      confirm >nul 2>&1

REM ============================================================
REM  [4/6] register services
REM ============================================================
echo [4/6] 注册服务...

if "%HAVE_STREAMER%"=="1" (
    echo   1. %STREAMER_SVC%  实时播放 :8000
    "%NSSM_EXE%" install %STREAMER_SVC% "%STREAMER_EXE%"
    "%NSSM_EXE%" set %STREAMER_SVC% AppParameters "%STREAMER_ARGS%"
    "%NSSM_EXE%" set %STREAMER_SVC% AppDirectory  "%STREAMER_DIR%"
    "%NSSM_EXE%" set %STREAMER_SVC% DisplayName   "KE 实时播放服务 WebRTC"
    "%NSSM_EXE%" set %STREAMER_SVC% Description   "RTSP to WebRTC, port 8000"
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
) else (
    echo   1. %STREAMER_SVC%  跳过, 缺少 webrtc-streamer.exe
)

echo   2. %PTZ_SVC%  云台控制 :3000
"%NSSM_EXE%" install %PTZ_SVC% "%NODE_EXE%"
"%NSSM_EXE%" set %PTZ_SVC% AppParameters "\"%PTZ_SCRIPT%\""
"%NSSM_EXE%" set %PTZ_SVC% AppDirectory  "%PTZ_DIR%"
"%NSSM_EXE%" set %PTZ_SVC% DisplayName   "KE 云台控制服务 ONVIF"
"%NSSM_EXE%" set %PTZ_SVC% Description   "ONVIF PTZ control, port 3000"
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

echo   3. %REC_SVC%  录像下载 :3001
"%NSSM_EXE%" install %REC_SVC% "%NODE_EXE%"
"%NSSM_EXE%" set %REC_SVC% AppParameters "\"%REC_SCRIPT%\""
"%NSSM_EXE%" set %REC_SVC% AppDirectory  "%REC_DIR%"
"%NSSM_EXE%" set %REC_SVC% DisplayName   "KE 录像下载服务"
"%NSSM_EXE%" set %REC_SVC% Description   "Hikvision record download, port 3001"
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

REM ---- 5/6 web console ----
echo [5/6] 注册网页调试台服务 %WEB_SVC% ...
"%NSSM_EXE%" install %WEB_SVC% "%NODE_EXE%"
"%NSSM_EXE%" set %WEB_SVC% AppParameters "\"%ROOT%\web\server.js\" --no-open"
"%NSSM_EXE%" set %WEB_SVC% AppDirectory  "%ROOT%"
"%NSSM_EXE%" set %WEB_SVC% DisplayName   "KE 摄像头调试台"
"%NSSM_EXE%" set %WEB_SVC% Description   "Camera debug console static web server, port 8080"
"%NSSM_EXE%" set %WEB_SVC% AppStdout     "%ROOT%\web-console.log"
"%NSSM_EXE%" set %WEB_SVC% AppStderr     "%ROOT%\web-console.log"
"%NSSM_EXE%" set %WEB_SVC% AppStdoutCreationDisposition 4
"%NSSM_EXE%" set %WEB_SVC% AppStderrCreationDisposition 4
"%NSSM_EXE%" set %WEB_SVC% AppRotateFiles 1
"%NSSM_EXE%" set %WEB_SVC% AppRotateBytes 10485760
"%NSSM_EXE%" set %WEB_SVC% Start SERVICE_AUTO_START
"%NSSM_EXE%" set %WEB_SVC% AppExit Default Restart
"%NSSM_EXE%" set %WEB_SVC% AppRestartDelay 5000
"%NSSM_EXE%" set %WEB_SVC% AppThrottle 5000
echo      [OK]
echo.

REM ============================================================
REM  [6/6] start services
REM ============================================================
echo [6/6] 启动服务...
if "%HAVE_STREAMER%"=="1" "%NSSM_EXE%" start %STREAMER_SVC%
"%NSSM_EXE%" start %PTZ_SVC%
"%NSSM_EXE%" start %REC_SVC%
"%NSSM_EXE%" start %WEB_SVC%
echo.
ping -n 5 127.0.0.1 >nul 2>&1

echo ============================================
echo   安装完成 - 服务状态
echo ============================================
if "%HAVE_STREAMER%"=="1" "%NSSM_EXE%" status %STREAMER_SVC%
"%NSSM_EXE%" status %PTZ_SVC%
"%NSSM_EXE%" status %REC_SVC%
"%NSSM_EXE%" status %WEB_SVC%
echo.
echo ============================================
echo   访问地址
echo ============================================
if "%HAVE_STREAMER%"=="1" echo   实时播放       : http://localhost:8000
echo   云台控制健康   : http://localhost:3000/health
echo   网页调试台     : http://localhost:8080
echo   录像下载首页   : http://localhost:3001
echo   下载健康检查   : http://localhost:3001/health
echo.
echo   提示: 外部浏览器访问不了, 请以管理员身份运行
echo         firewall-rules.bat 放行端口.
echo.
echo   管理命令:
echo     nssm restart %PTZ_SVC%
echo     nssm restart %REC_SVC%
echo     nssm restart %WEB_SVC%
if "%HAVE_STREAMER%"=="1" echo     nssm restart %STREAMER_SVC%
echo.
pause
