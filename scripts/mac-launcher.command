#!/bin/bash

# SEEBAL Reels — Launcher / Installer
# Removes macOS quarantine and opens the app

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="$SCRIPT_DIR/SEEBAL Reels.app"

if [ ! -d "$APP_PATH" ]; then
  osascript -e 'display dialog "Не найден файл SEEBAL Reels.app\n\nУбедитесь, что этот файл лежит рядом с приложением." buttons {"OK"} default button 1 with icon stop with title "SEEBAL Reels"'
  exit 1
fi

# Remove macOS quarantine silently
xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null

# Open the app
open "$APP_PATH"
