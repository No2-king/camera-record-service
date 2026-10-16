@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
REM ============================================================
REM  录像下载服务（独立包）—— 一键注册 Windows 服务
REM
REM    服务名 : KE-RecordService
REM    端口   : 3001
REM
REM  · 本脚本可放在任意路径, 自动以「脚本所在目录」为根目录
REM  · 所有需要的文件已随包自带 (Node 运行时 / NSSM / ffmpeg)
REM  · 无需手工配置任何东西, 也无需联网
REM  · 请【以管理员身份运行】
REM ============================================================

REM ---- 管理员权限检查 ----
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 请右键选择"以管理员身份运行"执行本脚本!
    echo.
    pause
    exit /b 1
)

REM ---- 以本脚本所在目录为根目录（关键: 保证整个文件夹可任意搬运）----
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NSSM_EXE=%ROOT%\nssm\nssm.exe"
set "NODE_EXE=%ROOT%\nodejs\node.exe"
set "REC_DIR=%ROOT%\record-service"
set "REC_SCRIPT=%ROOT%\record-service\server.js"
set "FFMPEG_EXE=%ROOT%\tools\ffmpeg.exe"
set "REC_SVC=KE-RecordService"
set "RECORD_PORT=3001"

echo ============================================
echo   录像下载服务 - 安装
echo ============================================
echo.
echo  根目录 : %ROOT%
echo  端口   : %RECORD_PORT%
echo.

REM ============================================================
REM  [1/5] 前置检查
REM ============================================================
echo [1/5] 前置检查...

if not exist "%NSSM_EXE%"   ( echo   [错误] 找不到 NSSM  : %NSSM_EXE%   & pause & exit /b 1 )
if not exist "%NODE_EXE%"   ( echo   [错误] 找不到 Node  : %NODE_EXE%   & pause & exit /b 1 )
if not exist "%REC_SCRIPT%" ( echo   [错误] 找不到服务代码: %REC_SCRIPT% & pause & exit /b 1 )
if not exist "%REC_DIR%\lib\isapi.js"  ( echo   [错误] 缺少 %REC_DIR%\lib\isapi.js  & pause & exit /b 1 )
if not exist "%REC_DIR%\lib\ffmpeg.js" ( echo   [错误] 缺少 %REC_DIR%\lib\ffmpeg.js & pause & exit /b 1 )

if not exist "%REC_DIR%\logs"      mkdir "%REC_DIR%\logs"      >nul 2>&1
if not exist "%REC_DIR%\downloads" mkdir "%REC_DIR%\downloads" >nul 2>&1

echo   [OK] 检查通过
echo.

REM ============================================================
REM  [2/5] 检查 ffmpeg（随包自带）
REM ============================================================
echo [2/5] 检查 ffmpeg...

if not exist "%FFMPEG_EXE%" (
    echo   [警告] 未找到 %FFMPEG_EXE%
    echo          下载功能将不可用! 请把 ffmpeg.exe 放到 tools\ 目录下.
    echo.
    goto :ffmpeg_done
)
echo   [OK] %FFMPEG_EXE%
echo.

:ffmpeg_done

REM ============================================================
REM  [3/5] 注册 ffmpeg 环境变量
REM       服务由 NSSM 以 LocalSystem 身份启动, 看不到用户级 PATH,
REM       所以既写系统变量, 又给服务单独设一份, 双保险.
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
    echo          (服务已单独配置 FFMPEG_PATH)
) else (
    echo   [OK] FFMPEG_PATH = %FFMPEG_EXE%
)
echo.

:env_done

REM ============================================================
REM  清理同名旧服务（保证重复执行安全）
REM ============================================================
"%NSSM_EXE%" stop   %REC_SVC% >nul 2>&1
"%NSSM_EXE%" remove %REC_SVC% confirm >nul 2>&1

REM ============================================================
REM  [4/5] 注册服务
REM ============================================================
echo [4/5] 注册服务...

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

REM ============================================================
REM  [5/5] 启动服务
REM ============================================================
echo [5/5] 启动服务...
"%NSSM_EXE%" start %REC_SVC%
echo.
ping -n 5 127.0.0.1 >nul 2>&1

echo ============================================
echo   安装完成
echo ============================================
"%NSSM_EXE%" status %REC_SVC%
echo.
echo ============================================
echo   访问地址
echo ============================================
echo   服务首页   : http://localhost:%RECORD_PORT%
echo   健康检查   : http://localhost:%RECORD_PORT%/health
echo   成品目录   : %REC_DIR%\downloads
echo.
echo   提示: 局域网其它机器访问不了, 请以管理员身份运行
echo         firewall-rules.bat 放行 %RECORD_PORT% 端口.
echo.
echo   管理命令:
echo     nssm restart %REC_SVC%
echo     nssm stop    %REC_SVC%
echo     nssm start   %REC_SVC%
echo.
pause
