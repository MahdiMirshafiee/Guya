#!/usr/bin/env bash
#
# Build for this machine and install it, the way macOS expects.
#
# Copying a bundle into /Applications is not enough: Launch Services keeps its own
# database, and a build that was once opened from dist/ leaves an entry pointing at
# a path that no longer exists — which is why a copied app can be missing from
# Launchpad. This script replaces the copy, tells Launch Services about it, and
# removes the build output so no stale path is left behind.
#
#   scripts/install.sh
#
set -euo pipefail

cd "$(dirname "$0")/.."

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
APP="/Applications/Guya.app"
# electron-builder names the unpacked directory after the architecture it built for, and a
# run on this machine builds for this machine. Hardcoding -arm64 removed the installed app
# and then failed to copy on an Intel Mac, leaving no app installed at all.
case "$(uname -m)" in
  arm64) BUNDLE="dist/mac-arm64/Guya.app" ;;
  *) BUNDLE="dist/mac/Guya.app" ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "this script installs the macOS app; use npm run dist:win elsewhere" >&2
  exit 1
fi

was_running=0
if pgrep -f "$APP/Contents/MacOS/Guya" >/dev/null 2>&1; then
  was_running=1
  osascript -e 'tell application "Guya" to quit' >/dev/null 2>&1 || pkill -f "$APP/Contents/MacOS/Guya" || true
  sleep 2
fi

echo "==> icons"
npm run icons

echo "==> tests"
npm test

echo "==> packaging"
npx electron-builder --mac dir

# The installed copy is only replaced once there is something to replace it with: this
# script used to delete it first and then fail on a missing bundle.
if [ ! -d "$BUNDLE" ]; then
  echo "no build at $BUNDLE — packaging did not produce the app" >&2
  exit 1
fi

echo "==> installing $APP"
rm -rf "$APP"
cp -R "$BUNDLE" /Applications/

echo "==> registering with Launch Services"
"$LSREGISTER" -f "$APP"

# Packaging registers the build copy too; deleting it afterwards would leave the
# very stale entry this script exists to avoid.
if [ -e "$BUNDLE" ]; then
  "$LSREGISTER" -u "$PWD/$BUNDLE" || true
fi
rm -rf dist

if [ "$was_running" -eq 1 ]; then
  open -a "$APP"
fi

echo
echo "installed — $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '?') at $APP"
