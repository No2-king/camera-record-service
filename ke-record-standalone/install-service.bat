@echo off
chcp 936 >nul
setlocal EnableDelayedExpansion
REM ============================================================
REM  录像下载服务（独立包）- 一键注册 Windows 服务
REM
REM    服务名 : KE-RecordService
REM    端口   : 3001
REM
REM  用法（右键 - 以管理员身份运行）:
REM    install-service.bat          检查 + 注册 + 启动
REM    install-service.bat check    只做前置检查，不改动系统
REM
REM  Node.js 运行时由 _find-node.bat 定位，查找顺序：
REM    系统 PATH  ->  本机常见安装目录  ->  本包内 nodejs\node.exe
REM  所以本机装过 Node 就直接用，没装才用包内自带的运行时。
REM
REM  批处理文件注意事项，请勿破坏：
REM    1. 本文件保存为 GBK 编码。UTF-8 中文在 cmd 下会被按
REM       ANSI 读取而与 ASCII 字节错位，导致整行被误当成命令。
REM    2. echo 行里不要出现半角圆括号。它在 if 块中会提前闭合
REM       代码块，使后面的语句漏到块外执行。
REM ============================================================

REM ---- 参数：检查模式 ----
set "CHECK_ONLY=0"
if /i "%~1"=="check"  set "CHECK_ONLY=1"
if /i "%~1"=="-check" set "CHECK_ONLY=1"

REM ---- 管理员权限检查，检查模式跳过 ----
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

REM ---- 以本脚本所在目录为根目录，保证整个文件夹可任意搬运 ----
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NSSM_EXE=%ROOT%\nssm\nssm.exe"
set "REC_DIR=%ROOT%\record-service"
set "REC_SCRIPT=%ROOT%\record-service\server.js"
set "FFMPEG_EXE=%ROOT%\tools\ffmpeg.exe"
set "REC_SVC=KE-RecordService"
set "WEB_SVC=KE-WebConsole"
set "RECORD_PORT=3001"

echo ============================================
echo   录像下载服务 - 安装
echo ============================================
echo.
echo  根目录 : %ROOT%
echo  端口   : %RECORD_PORT%
if "%CHECK_ONLY%"=="1" echo  模式   : 仅检查，不会修改系统
echo.

REM ============================================================
REM  [1/6] 前置检查
REM ============================================================
echo [1/6] 前置检查...

if not exist "%NSSM_EXE%" (
    echo   [错误] 找不到 NSSM: %NSSM_EXE%
    pause
    exit /b 1
)

REM ---- Node.js：本机环境优先，包内自带兜底 ----
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

if not exist "%REC_SCRIPT%" (
    echo   [错误] 找不到服务代码: %REC_SCRIPT%
    pause
    exit /b 1
)
if not exist "%REC_DIR%\lib\isapi.js" (
    echo   [错误] 缺少 %REC_DIR%\lib\isapi.js
    pause
    exit /b 1
)
if not exist "%REC_DIR%\lib\ffmpeg.js" (
    echo   [错误] 缺少 %REC_DIR%\lib\ffmpeg.js
    pause
    exit /b 1
)

if not exist "%REC_DIR%\logs"      mkdir "%REC_DIR%\logs"      >nul 2>&1
if not exist "%REC_DIR%\downloads" mkdir "%REC_DIR%\downloads" >nul 2>&1

echo   [OK] 检查通过
echo.

REM ============================================================
REM  [2/6] 检查 ffmpeg
REM ============================================================
echo [2/6] 检查 ffmpeg...

if not exist "%FFMPEG_EXE%" (
    echo   [警告] 未找到 %FFMPEG_EXE%
    echo          下载功能将不可用！ 请把 ffmpeg.exe 放到 tools 目录下.
    echo.
    goto :ffmpeg_done
)
echo   [OK] %FFMPEG_EXE%
echo.

:ffmpeg_done

REM ============================================================
REM  [3/6] 注册 ffmpeg 环境变量
REM  服务由 NSSM 以 LocalSystem 身份启动，看不到用户级 PATH，
REM  所以既写系统变量，又给服务单独设一份，双保险。
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
    echo          服务已单独配置 FFMPEG_PATH
) else (
    echo   [OK] FFMPEG_PATH = %FFMPEG_EXE%
)
echo.

:env_done

REM ============================================================
REM  检查模式到此结束
REM ============================================================
if "%CHECK_ONLY%"=="1" (
    echo ============================================
    echo   检查模式 - 未做任何修改
    echo ============================================
    echo   Node.js     : %NODE_VER%   [%NODE_SRC%]
    echo   node.exe    : %NODE_EXE%
    echo   npm         : %NPM_CMD%
    echo   record-svc  : %REC_SCRIPT%
    echo   ffmpeg      : %FFMPEG_EXE%
    echo.
    echo   去掉 check 参数即可正式安装.
    echo.
    pause
    exit /b 0
)

REM ============================================================
REM  清理同名旧服务，保证重复执行安全
REM ============================================================
"%NSSM_EXE%" stop   %REC_SVC% >nul 2>&1
"%NSSM_EXE%" remove %REC_SVC% confirm >nul 2>&1

REM ============================================================
REM  [4/6] 注册服务
REM ============================================================
echo [4/6] 注册服务...

"%NSSM_EXE%" install %REC_SVC% "%NODE_EXE%"
"%NSSM_EXE%" set %REC_SVC% AppParameters "\"%REC_SCRIPT%\""
"%NSSM_EXE%" set %REC_SVC% AppDirectory  "%REC_DIR%"
"%NSSM_EXE%" set %REC_SVC% DisplayName   "KE 录像下载服务"
"%NSSM_EXE%" set %REC_SVC% Description   "摄像头/NVR 历史录像下载, HTTP 接口, 端口 %RECORD_PORT%"
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
echo   [OK] %REC_SVC%
echo.

REM ---- web console ----
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
echo   [OK] %WEB_SVC%
echo.


REM ============================================================
REM  [6/6] 启动服务
REM ============================================================
echo [6/6] 启动服务...
"%NSSM_EXE%" start %REC_SVC%
"%NSSM_EXE%" start %WEB_SVC%
echo.
ping -n 5 127.0.0.1 >nul 2>&1

echo ============================================
echo   安装完成
echo ============================================
"%NSSM_EXE%" status %REC_SVC%
"%NSSM_EXE%" status %WEB_SVC%
echo.
echo ============================================
echo   访问地址
echo ============================================
echo   调试台     : http://localhost:8080
echo   服务首页   : http://localhost:%RECORD_PORT%
echo   健康检查   : http://localhost:%RECORD_PORT%/health
echo   成品目录   : %REC_DIR%\downloads
echo.
echo   提示: 局域网其它机器访问不了, 请以管理员身份运行
echo         firewall-rules.bat 放行 %RECORD_PORT% 端口.
echo.
echo   管理命令:
echo     nssm restart %REC_SVC%
echo     nssm restart %WEB_SVC%
echo     nssm stop    %REC_SVC%
echo     nssm start   %REC_SVC%
echo.
pause
