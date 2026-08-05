@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 o posterior no esta instalado.
  pause
  exit /b 1
)
if not exist node_modules call npm.cmd install
if not exist .env call npm.cmd run setup
set "MSC_APP_PORT=3000"
for /f "usebackq tokens=1,* delims==" %%A in (".env") do if /i "%%A"=="PORT" set "MSC_APP_PORT=%%B"
start "" "http://127.0.0.1:%MSC_APP_PORT%"
call npm.cmd run dev
pause
