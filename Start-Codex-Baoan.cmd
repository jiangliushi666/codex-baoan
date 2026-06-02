@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  call npm install
)
if not exist dist\cli.js (
  call npm run build
)
node dist\cli.js gui
pause
