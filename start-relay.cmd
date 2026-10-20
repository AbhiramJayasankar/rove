@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  call npm install
  if errorlevel 1 goto failed
)
call npm run build
if errorlevel 1 goto failed
echo Open http://127.0.0.1:4789 in Chrome.
call npm start
goto end
:failed
echo Relay could not start. Review the error above.
pause
:end
endlocal
