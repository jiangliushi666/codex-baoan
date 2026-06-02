@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Please run Install-Codex-Baoan.cmd first.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist dist\cli.js (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist node_modules\electron\dist\electron.exe (
  call node node_modules\electron\install.js
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm run desktop
if errorlevel 1 pause
