#!/bin/bash
# Kairos for macOS. Installs into your user account: no admin password, no code signing.
# One line in Terminal (installs or updates):
#   curl -fsSL https://github.com/__REPO__/releases/latest/download/install.sh | bash
# or, from an unzipped Kairos-mac folder:   bash install.sh
# (Gatekeeper only checks files a browser downloaded. A script handed to bash and files fetched
#  by curl are not flagged, which is why this works without an Apple Developer certificate.)
set -euo pipefail

REPO="${KAIROS_REPO:-__REPO__}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"

# Run through curl | bash: fetch the full package from the latest release, then run its installer.
if [ ! -d "$HERE/payload" ]; then
  case "$REPO" in *__REPO__*) printf 'This installer has no release address. Download Kairos-mac.tar.gz and run its install.sh.
' >&2; exit 1 ;; esac
  tmp="$(mktemp -d)"
  printf '
[1;38;5;208m🐾 Downloading Kairos[0m
'
  curl -fL# "https://github.com/$REPO/releases/latest/download/Kairos-mac.tar.gz" | tar -xz -C "$tmp"
  exec bash "$tmp/Kairos-mac/install.sh" </dev/null
fi
NODE_VERSION="v22.23.3"
PORT=2790
URL="http://127.0.0.1:$PORT/"
LABEL="app.kairos.engine"
SUPPORT="$HOME/Library/Application Support/Kairos"
RUNTIME="$SUPPORT/runtime"
VENDOR="$RUNTIME/vendor"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
APP="$HOME/Applications/Kairos.app"
UID_GUI="gui/$(id -u)"

say()  { printf '\n\033[1;38;5;208m🐾 %s\033[0m\n' "$1"; }
fail() { printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "This installer is for macOS."
case "$(uname -m)" in
  arm64)  ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) fail "Unsupported Mac ($(uname -m))." ;;
esac
[ "$(sw_vers -productVersion | cut -d. -f1)" -ge 12 ] || fail "Kairos needs macOS 12 (Monterey) or newer."
[ -d "$HERE/payload" ] || fail "Run this from the unzipped Kairos-mac folder."

# A browser download marks these files as quarantined. They are yours now, so lift the flag.
xattr -dr com.apple.quarantine "$HERE" 2>/dev/null || true

say "Stopping any running Kairos"
pkill -x Kairos 2>/dev/null || true # the app window/menu bar icon, if open
launchctl bootout "$UID_GUI/$LABEL" 2>/dev/null || true
pkill -f "$RUNTIME/app/engine/index.js" 2>/dev/null || true
sleep 2

say "Copying Kairos"
mkdir -p "$VENDOR/openwa" "$SUPPORT/logs" "$HOME/Library/LaunchAgents" "$HOME/Applications"
rm -rf "$RUNTIME/app"
cp -R "$HERE/payload/app" "$RUNTIME/app"
# OpenWA: keep its installed packages unless this release changed them.
if ! cmp -s "$HERE/payload/openwa/package-lock.json" "$VENDOR/openwa/package-lock.json" 2>/dev/null; then
  rm -rf "$VENDOR/openwa/node_modules"
fi
rm -rf "$VENDOR/openwa/dist" "$VENDOR/openwa/scripts"
cp -R "$HERE/payload/openwa/." "$VENDOR/openwa/"

if [ ! -x "$VENDOR/node/bin/node" ] || [ "$("$VENDOR/node/bin/node" -v)" != "$NODE_VERSION" ]; then
  say "Downloading Node.js $NODE_VERSION ($ARCH)"
  rm -rf "$VENDOR/node"
  tmp="$(mktemp -d)"
  curl -fL# "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-$ARCH.tar.gz" | tar -xz -C "$tmp"
  mv "$tmp/node-$NODE_VERSION-darwin-$ARCH" "$VENDOR/node"
  rm -rf "$tmp"
fi
export PATH="$VENDOR/node/bin:$PATH"
export PUPPETEER_CACHE_DIR="$VENDOR/puppeteer"

if [ ! -d "$VENDOR/openwa/node_modules" ]; then
  say "Installing the WhatsApp engine and headless Chrome (a few minutes)"
  cd "$VENDOR/openwa"
  # --ignore-scripts: never compile anything (no Xcode needed). The two scripts that matter run below.
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
  node scripts/postinstall.js >/dev/null
  node node_modules/puppeteer/install.mjs
  cd "$HERE"
fi

# The Kairos app (menu bar + window) when this package carries it; otherwise the browser page.
if [ -d "$HERE/payload/Kairos.app" ]; then UI_JSON="{\"cmd\":\"open\",\"args\":[\"-a\",\"$APP\",\"--args\"]}"; else UI_JSON="{\"url\":\"$URL\"}"; fi

say "Setting Kairos to run in the background"
cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$VENDOR/node/bin/node</string>
    <string>$RUNTIME/app/engine/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$RUNTIME/app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>KAIROS_VENDOR</key><string>$VENDOR</string>
    <key>KAIROS_UI</key><string>$UI_JSON</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <!-- Starts at login; restarts after a crash, but stays off after "Stop monitoring". -->
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$SUPPORT/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>$SUPPORT/logs/launchd.log</string>
</dict>
</plist>
PLIST
rm -f "$AGENT.disabled"
launchctl bootstrap "$UID_GUI" "$AGENT" 2>/dev/null || launchctl load -w "$AGENT"

say "Installing the Kairos app"
rm -rf "$APP"
if [ -d "$HERE/payload/Kairos.app" ]; then
  cp -R "$HERE/payload/Kairos.app" "$APP"
  xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
  codesign --force --deep -s - "$APP" 2>/dev/null || true # ad-hoc signature: Apple Silicon needs one
else
  make_launcher=1
fi
if [ -n "${make_launcher:-}" ]; then
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Kairos</string>
  <key>CFBundleDisplayName</key><string>Kairos</string>
  <key>CFBundleIdentifier</key><string>app.kairos.launcher</string>
  <key>CFBundleExecutable</key><string>Kairos</string>
  <key>CFBundleIconFile</key><string>Kairos</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict>
</plist>
PLIST
cat > "$APP/Contents/MacOS/Kairos" <<'LAUNCHER'
#!/bin/bash
# Opens Kairos in your browser, starting the background service first if it is not running.
URL="http://127.0.0.1:2790/"
LABEL="app.kairos.engine"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
RUNTIME="$HOME/Library/Application Support/Kairos/runtime"
if ! curl -s -m 2 "${URL}health" >/dev/null; then
  launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null \
    || launchctl bootstrap "gui/$(id -u)" "$AGENT" 2>/dev/null \
    || (cd "$RUNTIME/app" && KAIROS_VENDOR="$RUNTIME/vendor" KAIROS_UI="{\"url\":\"$URL\"}" \
        nohup "$RUNTIME/vendor/node/bin/node" engine/index.js >/dev/null 2>&1 &)
  for _ in $(seq 1 60); do curl -s -m 1 "${URL}health" >/dev/null && break; sleep 0.5; done
fi
open "$URL"
LAUNCHER
chmod +x "$APP/Contents/MacOS/Kairos"
# App icon from the Kairos logo, made with tools every Mac has (sips + iconutil).
iconset="$(mktemp -d)/Kairos.iconset"; mkdir -p "$iconset"
for s in 16 32 128 256 512; do
  sips -z $s $s "$RUNTIME/app/app/ui/assets/icon.png" --out "$iconset/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$RUNTIME/app/app/ui/assets/icon.png" --out "$iconset/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$APP/Contents/Resources/Kairos.icns" || true
fi
touch "$APP"

say "Starting Kairos"
for _ in $(seq 1 120); do curl -s -m 1 "${URL}health" >/dev/null && break; sleep 0.5; done
curl -s -m 1 "${URL}health" >/dev/null || fail "Kairos did not start. See: $SUPPORT/logs"
open "$APP"

printf '\n\033[1;32m✓ Kairos is installed.\033[0m\n'
echo "  • Open it any time from Applications → Kairos (or Launchpad). It also lives in the menu bar."
echo "  • To update later, run the same install command again."
echo "  • Monitoring keeps running when the tab is closed, and starts again when you log in."
echo "  • First start downloads the Epsilon model (~150 MB) in the background."
cp "$HERE/uninstall.sh" "$SUPPORT/uninstall.sh" 2>/dev/null || true
echo "  • To remove Kairos:  bash \"$SUPPORT/uninstall.sh\""
