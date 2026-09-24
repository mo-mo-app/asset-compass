@echo off
set "RUNTIME_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%RUNTIME_NODE%" (
  echo Codex runtime was not found. Please open this folder from Codex and try again.
  pause
  exit /b 1
)
start "Asset Compass Server" /min "%RUNTIME_NODE%" "%~dp0server.js"
timeout /t 1 /nobreak >nul
start "" http://127.0.0.1:8766
