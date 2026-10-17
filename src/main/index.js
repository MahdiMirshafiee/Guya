/*
 * Guya — minimal local voice-to-text on top of the Gemini API.
 *
 * This file is the composition root: it starts the pieces and wires the ones
 * that need to know about each other. Behaviour lives in the modules beside it —
 * ./recorder for a recording session, ./state for the phase, ./ipc for what the
 * renderers may ask for, ./system for what the OS is asked for.
 */
'use strict';

const { app, globalShortcut } = require('electron');

const store = require('./store');
const windows = require('./windows');
const appProtocol = require('./protocol');

/* The scheme has to be declared privileged before the app is ready, which is why
 * this cannot live inside start(): without it the pages are served from an opaque
 * origin, and the CSP's 'self' then matches nothing at all. */
appProtocol.registerScheme();

const platform = require('./platform');
const menu = require('./menu');
const permissions = require('./permissions');
const state_ = require('./state');
const recorder = require('./recorder');
const shortcutApi = require('./shortcuts');
const systemIntegration = require('./system');
const ipc = require('./ipc');

function start() {
  platform.applyDockIcon();
  appProtocol.install();
  permissions.install();
  menu.install();

  /* A renderer that crashes is a session that cannot continue: the overlay owns the
   * microphone, so its death has to end the session rather than leave the app
   * waiting for an answer that can no longer come. */
  windows.whenOverlayDies(() => {
    const phase = state_.state.phase;
    if (phase === 'starting' || phase === 'recording') recorder.reportMicFailure('error.micFailed');
    else windows.getOverlay(); // nothing was recording: just rebuild it quietly
  });

  windows.getOverlay(); // preload the overlay renderer so the first hotkey feels instant
  windows.getPanel();
  ipc.register();

  const shortcut = store.read().shortcut;
  const applied = shortcutApi.registerShortcut(shortcut);
  state_.state.shortcutErrorKey = applied.ok ? '' : applied.errorKey;
  if (!applied.ok) console.warn('[guya] shortcut unavailable:', shortcut);

  if (store.read().launchAtLogin) systemIntegration.loginItem(true);

  if (process.env.GUYA_DEBUG) {
    console.log(`[guya] ready — shortcut "${shortcut}"${applied.ok ? '' : ' (UNAVAILABLE)'}, settings at ${store.path}`);
  }

  state_.pushPanel();
  if (!store.read().apiKey) windows.showPanel();
}

/* One instance: a second launch is a request to show the window. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows.showPanel());
  app.whenReady().then(start);
  app.on('activate', () => windows.showPanel());

  /* Nothing quits the app by emptying the screen, on any platform. The shortcut is the
   * product; a window that is closed (or a renderer that dies) must not take it away.
   * Subscribing at all is what stops Electron's default behaviour of quitting when the
   * last window closes — the comment is the handler. */
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    app.isQuitting = true;
    recorder.clearTimers();
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
