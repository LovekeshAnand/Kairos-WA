#!/bin/bash
# Removes Kairos from this Mac. Your ~/Kairos documents are never touched.
set -uo pipefail
LABEL="app.kairos.engine"
SUPPORT="$HOME/Library/Application Support/Kairos"

pkill -x Kairos 2>/dev/null || true
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
pkill -f "$SUPPORT/runtime/app/engine/index.js" 2>/dev/null || true
pkill -f "$SUPPORT/runtime/vendor/openwa/dist/main.js" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$HOME/Library/LaunchAgents/$LABEL.plist.disabled"
rm -rf "$HOME/Applications/Kairos.app" "$SUPPORT/runtime"
echo "✓ Kairos app and background service removed."

read -r -p "Also delete settings, the WhatsApp login and the Epsilon model? [y/N] " answer </dev/tty || answer=n
if [[ "$answer" =~ ^[Yy]$ ]]; then
  rm -rf "$SUPPORT"
  echo "✓ Settings removed. (Unlink 'Kairos' in WhatsApp → Linked devices on your phone too.)"
fi
echo "Your documents in ~/Kairos were kept."
