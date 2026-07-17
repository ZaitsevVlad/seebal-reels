#!/bin/bash

# ssibalreels(beta) launcher.
# Removes macOS quarantine and opens the app.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_PATH="$SCRIPT_DIR/ssibalreels(beta).app"

if [ ! -d "$APP_PATH" ]; then
  osascript -e 'display dialog "ssibalreels(beta).app was not found next to this launcher." buttons {"OK"} default button 1 with icon stop with title "ssibalreels(beta)"'
  exit 1
fi

xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null
open "$APP_PATH"
