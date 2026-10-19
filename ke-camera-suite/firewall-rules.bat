@echo off
chcp 936 >nul
setlocal
REM ============================================================
REM  摄像头服务套件 —— Windows 防火墙规则管理
REM  以 管理员身份运行 执行本脚本
REM
REM  用法:
REM    firewall-rules.bat          添加规则
REM    firewall-rules.bat remove   删除规则
REM ============================================================

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 请选择"以管理员身份运行"执行本脚本！
    echo.
    pause
    exit /b 1
)

set "MODE=add"
if /i "%~1"=="remove" set "MODE=delete"

set "R1=WebRTC-Streamer-TCP-In"
set "R2=WebRTC-Streamer-TCP-Out"
set "R3=WebRTC-STUN-UDP-In"
set "R4=WebRTC-STUN-UDP-Out"
set "R5=WebRTC-Media-UDP-In"
set "R6=WebRTC-Media-UDP-Out"
set "R7=Onvif-PTZ-TCP-In"
set "R8=Onvif-PTZ-TCP-Out"
set "R9=Record-Service-TCP-In"
set "R10=Record-Service-TCP-Out"
set "R11=WebConsole-TCP-In"
set "R12=WebConsole-TCP-Out"

echo ============================================
if /i "%MODE%"=="delete" (echo   删除防火墙规则) else (echo   添加防火墙规则)
echo ============================================
echo.

if /i "%MODE%"=="delete" goto :DELETE

REM ---------------- 添加规则 ----------------
netsh advfirewall firewall add rule name="%R1%" dir=in  action=allow protocol=TCP localport=8000,3478
netsh advfirewall firewall add rule name="%R2%" dir=out action=allow protocol=TCP localport=8000,3478
netsh advfirewall firewall add rule name="%R3%" dir=in  action=allow protocol=UDP localport=3478
netsh advfirewall firewall add rule name="%R4%" dir=out action=allow protocol=UDP localport=3478
netsh advfirewall firewall add rule name="%R5%" dir=in  action=allow protocol=UDP localport=49152-65535
netsh advfirewall firewall add rule name="%R6%" dir=out action=allow protocol=UDP localport=49152-65535
netsh advfirewall firewall add rule name="%R7%" dir=in  action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="%R8%" dir=out action=allow protocol=TCP localport=3000
netsh advfirewall firewall add rule name="%R9%" dir=in  action=allow protocol=TCP localport=3001
netsh advfirewall firewall add rule name="%R10%" dir=out action=allow protocol=TCP localport=3001
netsh advfirewall firewall add rule name="%R11%" dir=in  action=allow protocol=TCP localport=8080
netsh advfirewall firewall add rule name="%R12%" dir=out action=allow protocol=TCP localport=8080

echo.
echo ============================================
echo   防火墙规则添加成功
echo ============================================
echo   TCP 8000         webrtc-streamer 网页与 API
echo   TCP/UDP 3478     内置 STUN 服务器
echo   UDP 49152-65535  WebRTC 媒体流端口范围
echo   TCP 3000         ONVIF PTZ 云台控制 API
echo   TCP 3001         录像下载服务 API
echo   TCP 8080         网页调试台（局域网其它机器访问用这个）
echo ============================================
echo.
echo  安全提示: 生产环境使用时, 建议将规则限定为
echo            本网段, 可在规则后追加 remoteip=localsubnet
echo.
pause
exit /b 0

:DELETE
for %%R in ("%R1%" "%R2%" "%R3%" "%R4%" "%R5%" "%R6%" "%R7%" "%R8%" "%R9%" "%R10%" "%R11%" "%R12%") do (
    netsh advfirewall firewall delete rule name=%%~R >nul 2>&1
    echo   已删除 %%~R
)
echo.
echo ============================================
echo   防火墙规则已全部删除
echo ============================================
pause
