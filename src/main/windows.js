/*
 * The two windows: the settings panel (a glass sheet) and the circular
 * recording overlay. Both load their pages from app://bundle/, which keeps CSP,
 * modules and fonts behaving the same on every platform.
 */
'use strict';

const path = require('path');
const { BrowserWindow, screen, nativeTheme, app } = require('electron');
const appProtocol = require('./protocol');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const OVERLAY_WIDTH = 220;
const OVERLAY_HEIGHT = 148;
const OVERLAY_TOP_GAP = 18;

let panelWin = null;
let overlayWin = null;
let overlayReady = null;

function rendererUrl(name) {
  return appProtocol.url('renderer/' + name);
}

/* Set GUYA_DEBUG=1 to see renderer errors and failed loads in the terminal. */
const DEBUG = !!process.env.GUYA_DEBUG;

function traceRenderer(win, label) {
  if (!DEBUG) return;
  win.webContents.on('console-message', (event) => {
    // Electron used to hand over a numeric level, newer versions a string.
    const level = event && event.level !== undefined ? event.level : '';
    const text = event && event.message !== undefined ? event.message : String(event);
    const isError = level === 'error' || (typeof level === 'number' && level >= 2);
    console.log(`[renderer:${label}] ${isError ? 'ERROR ' : ''}${text}`);
  });
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    console.error(`[renderer:${label}] failed to load ${url}: ${description} (${code})`);
  });
}

/* ---------------------------------------------------------------- panel ---- */

function createPanel() {
  const dark = nativeTheme.shouldUseDarkColors;
  panelWin = new BrowserWindow({
    width: 480,
    height: 800,
    minWidth: 440,
    minHeight: 560,
    show: false,
    title: 'Guya',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    /* This window spends its life in the background — the shortcut works from any
     * app — so the click that brings it forward is usually the click the user aimed
     * at a control. Without this the first one only focused the window, and the
     * control looked broken. */
    acceptFirstMouse: true,
    // Real desktop material behind the page: macOS vibrancy, Windows acrylic.
    backgroundColor: IS_MAC ? '#00000000' : dark ? '#1c1c20' : '#f1f1f4',
    ...(IS_MAC ? { vibrancy: 'under-window', visualEffectState: 'followWindow' } : {}),
    ...(IS_WIN ? { backgroundMaterial: 'acrylic' } : {}),
    /* The window buttons stay out of the layout and appear when the pointer
     * reaches for them: nothing in the app has to reserve space for them. */
    titleBarStyle: IS_MAC ? 'customButtonsOnHover' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 14 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });
  panelWin.loadURL(rendererUrl('panel/panel.html'));
  traceRenderer(panelWin, 'panel');

  panelWin.webContents.on('render-process-gone', () => {
    if (panelWin && !panelWin.isDestroyed()) panelWin.reload();
  });

  /* The overlay window is hidden rather than closed, so it would keep the app alive
   * for ever on a platform where closing the window is how the user quits. */
  panelWin.on('closed', () => {
    if (!IS_MAC && !app.isQuitting) app.quit();
  });

  panelWin.on('close', (event) => {
    // On macOS the app keeps living in the dock; elsewhere closing means quit.
    if (IS_MAC && !app.isQuitting) {
      event.preventDefault();
      panelWin.hide();
    }
  });
  return panelWin;
}

function getPanel() {
  if (panelWin && !panelWin.isDestroyed()) return panelWin;
  return createPanel();
}

function showPanel() {
  const win = getPanel();
  if (win.isMinimized()) win.restore();
  win.show();
  if (IS_MAC) app.focus({ steal: true });
  win.focus();
  return win;
}

function togglePanel() {
  const win = getPanel();
  if (win.isVisible() && win.isFocused()) win.hide();
  else showPanel();
}

function sendToPanel(channel, payload) {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send(channel, payload);
}

/* -------------------------------------------------------------- overlay ---- */

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    acceptFirstMouse: true,
    type: IS_MAC ? 'panel' : 'toolbar',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // The overlay must never steal clicks from the app the user is speaking into.
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (IS_MAC && overlayWin.setWindowButtonVisibility) overlayWin.setWindowButtonVisibility(false);

  overlayReady = new Promise((resolve) => overlayWin.webContents.once('did-finish-load', resolve));
  overlayWin.webContents.on('did-finish-load', () => overlayWin.hide());

  /* A renderer that dies takes the microphone with it. Rebuild it on the next use
   * and tell whoever is listening: without this, every start failed ten seconds
   * later with no explanation. */
  overlayWin.webContents.on('render-process-gone', () => {
    try {
      overlayWin.destroy();
    } catch (_) {
      /* already gone */
    }
    overlayWin = null;
    overlayReady = null;
    notifyOverlayGone();
  });
  overlayWin.loadURL(rendererUrl('overlay/overlay.html'));
  traceRenderer(overlayWin, 'overlay');
  return overlayWin;
}

function getOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
  return createOverlay();
}

/* Centres the circle horizontally near the top of the display the cursor is on,
 * matching whatever screen the user is actually working on. */
function positionOverlay() {
  const win = getOverlay();
  let area;
  try {
    area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  } catch (_) {
    area = screen.getPrimaryDisplay().workArea;
  }
  const x = Math.round(area.x + (area.width - OVERLAY_WIDTH) / 2);
  const y = Math.round(area.y + OVERLAY_TOP_GAP);
  win.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
}

function showOverlay() {
  positionOverlay();
  const win = getOverlay();
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function hideOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
  /* The renderer keeps its animation frame running while hidden — the window is not
   * throttled, so that it can capture — so it has to be told to stop drawing. */
  sendToOverlay({ type: 'idle' });
  overlayWin.hide();
}

/* True when the recorder window is on screen and in front: the window already
 * shows the meter, the timer and the orb, so the floating overlay would only
 * repeat it. */
function panelHasFocus() {
  return !!(panelWin && !panelWin.isDestroyed() && panelWin.isVisible() && panelWin.isFocused());
}

function sendToOverlay(payload) {
  const win = overlayWin;
  if (!win || win.isDestroyed()) return;
  const deliver = () => {
    if (!win.isDestroyed()) win.webContents.send('overlay:command', payload);
  };
  if (win.webContents.isLoading()) overlayReady.then(deliver);
  else deliver();
}

/* Set by the composition root: windows.js cannot require recorder (that would be a
 * cycle), so a dead renderer is reported outward instead of handled here. */
let onOverlayGone = null;
function whenOverlayDies(handler) {
  onOverlayGone = handler;
}
function notifyOverlayGone() {
  if (onOverlayGone) onOverlayGone();
}

module.exports = {
  whenOverlayDies,
  getPanel,
  showPanel,
  panelHasFocus,
  togglePanel,
  sendToPanel,
  getOverlay,
  showOverlay,
  hideOverlay,
  sendToOverlay,
  OVERLAY_WIDTH,
  OVERLAY_HEIGHT
};
