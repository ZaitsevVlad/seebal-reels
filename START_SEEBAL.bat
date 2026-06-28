@echo off
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "NODE_PATH=C:\Users\user\Desktop\insta-reels-downloader\.node\node-v22.16.0-win-x64"
set "ELECTRON=C:\Users\user\Desktop\insta-reels-downloader\node_modules\.bin\electron.cmd"
set "PATH=%NODE_PATH%;%PATH%"
cd /d "%ROOT%"
call "%ELECTRON%" "%ROOT%"
