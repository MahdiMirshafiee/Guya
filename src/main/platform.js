/*
 * Guya — the few things that differ per system, in one place.
 */
'use strict';

const path = require('path');
const os = require('os');
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

/* Whether the system draws a window material (Windows acrylic) for a window whose
 * background is transparent. Only Windows 11 22H2 and newer do: build 22621 is where the
 * material was added, and below it the option is ignored and the page's own translucent
 * tint would sit on black. Takes the string `os.release()` returns, e.g. '10.0.22631'.
 * Pure, so it can be tested from a machine that is not Windows. */
function supportsWindowMaterial(release) {
  const parts = String(release || '').split('.');
  if (parts.length < 3) return false;
  const numbers = parts.slice(0, 3).map((part) => Number(part));
  if (numbers.some((value) => !Number.isInteger(value) || value < 0)) return false;
  return numbers[0] === 10 && numbers[1] === 0 && numbers[2] >= 22621;
}

module.exports = { systemAccent, applyDockIcon, supportsWindowMaterial, IS_MAC, HOST_RELEASE: os.release() };
