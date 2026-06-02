@echo off
setlocal
set "SCRIPT=%TEMP%\install-codex-baoan.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/jiangliushi666/codex-baoan/main/install.ps1' -OutFile '%SCRIPT%'"
powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%"
pause
