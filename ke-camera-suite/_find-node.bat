@echo off
chcp 936 >nul
REM ============================================================
REM  _find-node.bat - locate the Node.js runtime (internal helper)
REM
REM  Called by install-service.bat / start-web.bat / start.bat.
REM  Can also be run alone to see what it resolves:
REM      _find-node.bat
REM      _find-node.bat verbose
REM
REM  Lookup order (local machine first, bundled runtime as fallback):
REM    1) Node.js already installed on this machine - system PATH
REM    2) Common install locations - Program Files / nvm / LOCALAPPDATA
REM    3) Runtime shipped inside this package - <ROOT>\nodejs\node.exe
REM
REM  Rationale: if the machine already has Node, reuse it (newer and
REM  path-stable); only fall back to the bundled node.exe otherwise.
REM
REM  Output variables for the caller:
REM    NODE_EXE    absolute path of node.exe, empty when not found
REM    NPM_CMD     absolute path of npm.cmd, may be empty
REM    NODE_SRC    where it came from
REM    NODE_VER    version string, e.g. v22.22.2
REM    NODE_MAJOR  major version number, e.g. 22
REM
REM  NOTE: keep comments ASCII-only. cmd.exe can desync its byte
REM  position on UTF-8 multi-byte comment lines and then execute
REM  fragments of them as commands. Chinese is fine inside echo.
REM ============================================================

if not defined ROOT set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"

set "NODE_EXE="
set "NPM_CMD="
set "NODE_SRC="
set "NODE_VER="
set "NODE_MAJOR="
set "NODE_DIR="

REM ------------------------------------------------------------
REM  (1) node from system PATH
REM      Skip the Microsoft Store placeholder stub at
REM      %LOCALAPPDATA%\Microsoft\WindowsApps\node.exe - the file
REM      exists but just opens the Store, it is not a runtime.
REM ------------------------------------------------------------
for /f "delims=" %%I in ('where node.exe 2^>nul') do (
    if not defined NODE_EXE (
        if /i not "%%~dpI"=="%LOCALAPPDATA%\Microsoft\WindowsApps\" set "NODE_EXE=%%~fI"
    )
)
if defined NODE_EXE set "NODE_SRC=系统 PATH"

REM ------------------------------------------------------------
REM  (2) common install locations (installed but not on PATH)
REM      These statements must stay outside any if/for block:
REM      %ProgramFiles(x86)% expands to a path containing
REM      parentheses, which would break block parsing.
REM ------------------------------------------------------------
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if defined NVM_SYMLINK if exist "%NVM_SYMLINK%\node.exe" set "NODE_EXE=%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE if defined NVM_HOME if exist "%NVM_HOME%\node.exe" set "NODE_EXE=%NVM_HOME%\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_SRC if defined NODE_EXE set "NODE_SRC=本机安装目录"

REM ------------------------------------------------------------
REM  (3) runtime shipped inside this package (search current folder)
REM ------------------------------------------------------------
if not defined NODE_EXE if exist "%ROOT%\nodejs\node.exe" set "NODE_EXE=%ROOT%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ROOT%\node\node.exe" set "NODE_EXE=%ROOT%\node\node.exe"
if not defined NODE_EXE if exist "%ROOT%\runtime\nodejs\node.exe" set "NODE_EXE=%ROOT%\runtime\nodejs\node.exe"
if not defined NODE_EXE if exist "%ROOT%\tools\node.exe" set "NODE_EXE=%ROOT%\tools\node.exe"
if not defined NODE_EXE if exist "%ROOT%\bin\node.exe" set "NODE_EXE=%ROOT%\bin\node.exe"
if not defined NODE_EXE if exist "%ROOT%\node.exe" set "NODE_EXE=%ROOT%\node.exe"
if not defined NODE_SRC if defined NODE_EXE set "NODE_SRC=包内自带"

REM ------------------------------------------------------------
REM  npm - used to install onvif-ptz dependencies
REM ------------------------------------------------------------
if defined NODE_EXE for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
if defined NODE_DIR if exist "%NODE_DIR%npm.cmd" set "NPM_CMD=%NODE_DIR%npm.cmd"
if not defined NPM_CMD (
    for /f "delims=" %%I in ('where npm.cmd 2^>nul') do (
        if not defined NPM_CMD set "NPM_CMD=%%~fI"
    )
)

REM ------------------------------------------------------------
REM  Version - write to a temp file then read it back, so paths
REM  containing spaces survive the round trip.
REM ------------------------------------------------------------
set "_KE_NV=%TEMP%\ke_node_ver_%RANDOM%%RANDOM%.txt"
if defined NODE_EXE "%NODE_EXE%" -v > "%_KE_NV%" 2>nul
if exist "%_KE_NV%" set /p NODE_VER=<"%_KE_NV%"
if exist "%_KE_NV%" del "%_KE_NV%" >nul 2>&1

if defined NODE_VER set "NODE_VER_NOV=%NODE_VER:v=%"
if defined NODE_VER_NOV for /f "tokens=1 delims=." %%a in ("%NODE_VER_NOV%") do set "NODE_MAJOR=%%a"

REM ------------------------------------------------------------
REM  Print result when run standalone
REM ------------------------------------------------------------
if /i "%~1"=="verbose" (
    echo   查找顺序 : 本机 PATH -^> 本机安装目录 -^> 包内自带
    echo   包目录   : %ROOT%
    echo   node     : %NODE_EXE%
    echo   npm      : %NPM_CMD%
    echo   来源     : %NODE_SRC%
    echo   版本     : %NODE_VER%
    echo.
)

exit /b 0
