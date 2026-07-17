@echo off
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

if exist "%ROOT%\node_modules\electron\dist\electron.exe" (
  "%ROOT%\node_modules\electron\dist\electron.exe" "%ROOT%"
  exit /b %ERRORLEVEL%
)

if exist "%ROOT%\node_modules\.bin\electron.cmd" (
  call "%ROOT%\node_modules\.bin\electron.cmd" "%ROOT%"
  exit /b %ERRORLEVEL%
)

where npm >nul 2>nul
if errorlevel 1 (
  echo Node.js / npm is not installed.
  echo Install Node.js LTS, then run: npm install
  pause
  exit /b 1
)

if not exist "%ROOT%\node_modules" (
  echo Installing dependencies...
  call npm install
)

call "%ROOT%\node_modules\.bin\electron.cmd" "%ROOT%"
pause
