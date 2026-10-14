/*
 * Guya — the few things that differ per system, in one place.
 */
'use strict';

const path = require('path');
const { app, nativeImage, systemPreferences } = require('electron');

const IS_MAC = process.platform === 'darwin';
const FALLBACK_ACCENT = '#0a7cff';

/* The app has no brand colour: controls inherit the system accent. */
function systemAccent() {
  if (!IS_MAC) return FALLBACK_ACCENT;
  try {
    const hex = systemPreferences.getAccentColor();
    return hex && /^[0-9a-f]{8}$/i.test(hex) ? '#' + hex.slice(0, 6) : FALLBACK_ACCENT;
  } catch (_) {
    return FALLBACK_ACCENT;
  }
}

/* Unpackaged, macOS shows Electron's own icon in the Dock; a packaged build uses
 * the .icns from build/icon.png, so this only fills the gap during development. */
function applyDockIcon() {
  if (!IS_MAC || app.isPackaged || !app.dock) return;
  const image = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon.png'));
  if (image.isEmpty()) {
    if (process.env.GUYA_DEBUG) console.warn('[guya] dock icon: assets/icon.png missing, run "npm run icons"');
    return;
  }
  app.dock.setIcon(image);
  if (process.env.GUYA_DEBUG) {
    const size = image.getSize();
    console.log(`[guya] dock icon: ${size.width}x${size.height}`);
  }
}

module.exports = { systemAccent, applyDockIcon, IS_MAC };
