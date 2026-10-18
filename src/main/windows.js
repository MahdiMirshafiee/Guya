/*
 * The two windows: the settings panel (a glass sheet) and the circular
 * recording overlay. Both load their pages from app://bundle/, which keeps CSP,
 * modules and fonts behaving the same on every platform.
 */
'use strict';

const path = require('path');
const os = require('os');
const { BrowserWindow, screen, nativeTheme, app } = require('electron');
const appProtocol = require('./protocol');
const platform = require('./platform');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

const OVERLAY_WIDTH = 220;
const OVERLAY_HEIGHT = 148;
const OVERLAY_TOP_GAP = 18;

/* A material is only visible through a transparent window background, so an opaque colour
 * is what older Windows and Linux get instead — there is no material to show, and a
 * transparent window with nothing behind it shows black through the page's own tint. */
const HAS_MATERIAL = IS_WIN && platform.supportsWindowMaterial(os.release());

function solidBackground() {
  return nativeTheme.shouldUseDarkColors ? '#1c1c20' : '#f1f1f4';
}

let panelWin = null;
let overlayWin = null;
let overlayReady = null;
/* Whether the overlay is meant to be on screen right now. A window that is rebuilt while
 * a recording is running is shown because this says so, and a page finishing its load
 * hides itself only when it does not. */
let overlayWanted = false;

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
    /* Real desktop material behind the page: macOS vibrancy, and acrylic on the Windows
     * versions that draw it — both through a transparent background, because an opaque one
     * covers the material the system painted behind it. Everywhere else the window is a
     * solid colour under the page's own tint, which is what the light theme needs to look
     * light rather than a grey film over black. */
    backgroundColor: IS_MAC || HAS_MATERIAL ? '#00000000' : solidBackground(),
    ...(IS_MAC ? { vibrancy: 'under-window', visualEffectState: 'followWindow' } : {}),
    ...(HAS_MATERIAL ? { backgroundMaterial: 'acrylic' } : {}),
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

  /* A solid colour is a colour the system can change under us: switching the appearance
   * while the app runs leaves the window in the colour it was born with until it is
   * reopened. */
  if (!(IS_MAC || HAS_MATERIAL)) {
    const repaint = () => {
      if (panelWin && !panelWin.isDestroyed()) panelWin.setBackgroundColor(solidBackground());
    };
    nativeTheme.on('updated', repaint);
    panelWin.once('closed', () => nativeTheme.removeListener('updated', repaint));
  }

  /* Closing the window hides it, on every platform. The app's whole job is the
   * shortcut, and a shortcut that stops working because the window was closed is not a
   * background utility — on Windows and Linux, where the window is closed with the
   * system's own button, that was exactly what happened. Quitting is the menu's job
   * (`Ctrl+Q` while the window is open), or the settings screen's where there is no menu;
   * opening the app again brings the window back, because a second launch asks the first
   * one to show it.
   *
   * A page that closes itself is the one thing this cannot intercept, and it takes the
   * window with it — measured, not assumed. The app is what matters and the app stays:
   * `getPanel` builds the window again when it is next needed, which is the path a second
   * launch takes anyway. */
  panelWin.on('close', (event) => {
    if (app.isQuitting) return;
    event.preventDefault();
    panelWin.hide();
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
  /* The app is a regular macOS app — Dock icon, menu bar, Cmd+Q — and Electron's default
   * for this call is to switch the process to "UI element", which takes all three away. The
   * overlay is a `panel`-type window, so it keeps its place over full-screen apps through the
   * collection behaviour alone. */
  overlayWin.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    ...(IS_MAC ? { skipTransformProcessType: true } : {})
  });
  if (IS_MAC && overlayWin.setWindowButtonVisibility) overlayWin.setWindowButtonVisibility(false);

  /* The page starts hidden (`show: false`), and it stays that way until somebody asks
   * for it — a window that has just been built has not been asked for. Hiding it when
   * the load finishes was the wrong half of that: a recording that starts while the page
   * is still loading (the first press after launch, or the press that follows a crashed
   * renderer, which rebuilds the window) got its window shown and then hidden from under
   * it by its own load event, leaving an invisible orb over a live microphone. */
  overlayWanted = false;
  overlayReady = new Promise((resolve) => {
    const settle = () => resolve();
    overlayWin.webContents.once('did-finish-load', () => {
      if (overlayWin && !overlayWin.isDestroyed() && !overlayWanted) overlayWin.hide();
      settle();
    });
    /* A page that never loads must not leave every queued command waiting for an event
     * that will not come: the recording then fails ten seconds later saying the
     * microphone could not be started, with the queued start still in the promise. */
    overlayWin.webContents.once('did-fail-load', (_event, code, description) => {
      console.error(`[guya] the overlay page did not load: ${description} (${code})`);
      settle();
    });
  });

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
  overlayWanted = true;
  win.showInactive();
  win.setAlwaysOnTop(true, 'screen-saver');
}

function hideOverlay() {
  overlayWanted = false;
  if (!overlayWin || overlayWin.isDestroyed()) return;
  /* The renderer keeps its animation frame running while hidden — the window is not
   * throttled, so that it can capture — so it has to be told to stop drawing. That is
   * true whether or not the window was ever shown: with the panel in front the overlay
   * is never displayed, and it would otherwise draw for the rest of the session. */
  sendToOverlay({ type: 'idle' });
  if (overlayWin.isVisible()) overlayWin.hide();
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
