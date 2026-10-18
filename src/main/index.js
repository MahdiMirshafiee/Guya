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

/* A Wayland session hands global shortcuts out through a portal and nowhere else:
 * without this the shortcut never fires on Linux/Wayland, and there is no error to
 * see — `register` succeeds and the key simply does nothing. X11 is unaffected. */
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal');

const platform = require('./platform');
const menu = require('./menu');
const permissions = require('./permissions');
const state_ = require('./state');
const recorder = require('./recorder');
const shortcutApi = require('./shortcuts');
const systemIntegration = require('./system');
const ipc = require('./ipc');

/* The window, and the shortcut. Asked for together because the second launch of the app is
 * how the window is brought back — and because a key that was taken when the app started is
 * worth asking for again by then. */
function showWindow() {
  shortcutApi.ensureHeld();
  state_.pushPanel();
  windows.showPanel();
}

function start() {
  /* Windows identifies an app by this string, not by its name: without it the installed
   * build takes its identity from the shortcut the installer made and the portable one
   * has none, so the same app shows up twice on the taskbar and in the jump list. The
   * value is the bundle id the installer is built with. */
  if (process.platform === 'win32') app.setAppUserModelId('com.local.guya');

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

  /* The window the user is waiting for comes first. The overlay is still built at startup,
   * because the first press has to find its orb already there, but a second renderer process
   * ahead of the panel is a second renderer process's worth of waiting on Windows. */
  windows.getPanel();
  ipc.register();
  windows.getOverlay();

  const shortcut = store.read().shortcut;
  const applied = shortcutApi.registerShortcut(shortcut);
  state_.state.shortcutErrorKey = applied.ok ? '' : applied.errorKey;
  state_.state.shortcutHeld = applied.ok;
  if (!applied.ok) {
    /* Not fatal and not silent: the value stays in the settings file — the user chose it,
     * and another app may give the combination back — and the window says it is not
     * holding it. Asked again every time the window is opened. */
    console.warn('[guya] the shortcut is not available on this system:', shortcut, applied.errorKey);
  }

  if (store.read().launchAtLogin) systemIntegration.loginItem(true);

  if (process.env.GUYA_DEBUG) {
    console.log(`[guya] ready — shortcut "${shortcut}"${applied.ok ? '' : ' (UNAVAILABLE)'}, settings at ${store.path}`);
  }

  state_.pushPanel();
  /* A person who launched the app is asking for its window; the login item is not. Without
   * this, a configured install opened nothing at all — and on Windows and Linux, which have
   * no Dock and no menu, the first click appeared to do nothing: that process finds the
   * single-instance lock taken, quits, and only the *next* click shows the window. */
  if (!store.read().apiKey || !systemIntegration.startedAtLogin()) windows.showPanel();
}

/* One instance: a second launch is a request to show the window. */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.whenReady().then(start);
  app.on('activate', showWindow);

  /* Nothing quits the app by emptying the screen, on any platform. The shortcut is the
   * product; a window that is closed (or a renderer that dies) must not take it away.
   * Subscribing at all is what stops Electron's default behaviour of quitting when the
   * last window closes — the comment is the handler. */
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    app.isQuitting = true;
    recorder.clearTimers();
    shortcutApi.stopWatching();
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
