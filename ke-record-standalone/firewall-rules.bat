@echo off
chcp 65001 >nul
setlocal
REM ============================================================
REM  录像下载服务（独立包）—— Windows 防火墙规则
REM  请【以管理员身份运行】
REM
REM  用法:
REM    firewall-rules.bat          添加规则 (放行 3001)
REM    firewall-rules.bat remove   删除规则
REM ============================================================

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo [错误] 请右键选择"以管理员身份运行"执行本脚本!
    echo.
    pause
    exit /b 1
)

set "MODE=add"
if /i "%~1"=="remove" set "MODE=delete"

set "R1=Record-Service-TCP-In"
set "R2=Record-Service-TCP-Out"

echo ============================================
if /i "%MODE%"=="delete" (echo   删除防火墙规则) else (echo   添加防火墙规则)
echo ============================================
echo.

if /i "%MODE%"=="delete" goto :DELETE

netsh advfirewall firewall add rule name="%R1%" dir=in  action=allow protocol=TCP localport=3001
netsh advfirewall firewall add rule name="%R2%" dir=out action=allow protocol=TCP localport=3001

echo.
echo ============================================
echo   防火墙规则添加成功
echo ============================================
echo   TCP 3001   录像下载服务 API
echo ============================================
echo.
echo  安全提示: 生产环境建议限定网段, 可在规则后追加
echo            remoteip=localsubnet
echo.
pause
exit /b 0

:DELETE
for %%R in ("%R1%" "%R2%") do (
    netsh advfirewall firewall delete rule name=%%~R >nul 2>&1
    echo   已删除 %%~R
)
echo.
echo ============================================
echo   防火墙规则已全部删除
echo ============================================
pause
