/*
 * Guya — minimal local voice-to-text on top of the Gemini API.
 *
 * One shortcut toggles recording. While recording, a small glass circle sits at
 * the top of the screen; pressing the shortcut again stops it, the audio goes to
 * Gemini, and the transcript lands in the clipboard (and optionally gets typed
 * into whichever app has focus).
 */
'use strict';

const path = require('path');
const { app, globalShortcut, ipcMain, Menu, nativeTheme, session, nativeImage, systemPreferences } = require('electron');

const store = require('./store');
const gemini = require('./gemini');
const systemIntegration = require('./system');
const windows = require('./windows');
const appProtocol = require('./protocol');
const { KNOWN_MODELS, MAX_RECORDING_MS, SILENCE_CHOICES, ATTEMPT_CHOICES } = require('../shared/defaults');
const accelerator = require('../shared/accelerator');
const i18n = require('../shared/i18n');

const IS_MAC = process.platform === 'darwin';

/* The app has no brand colour: controls inherit the system accent. */
const FALLBACK_ACCENT = '#0a7cff';
function systemAccent() {
  if (!IS_MAC) return FALLBACK_ACCENT;
  try {
    const hex = systemPreferences.getAccentColor();
    return hex && /^[0-9a-f]{8}$/i.test(hex) ? '#' + hex.slice(0, 6) : FALLBACK_ACCENT;
  } catch (_) {
    return FALLBACK_ACCENT;
  }
}

// Must happen before the app is ready.
appProtocol.registerScheme();
if (IS_MAC) app.setAboutPanelOptions({ applicationName: 'Guya', applicationVersion: app.getVersion() });

const MIN_AUDIO_SECONDS = 0.35;

const state = {
  phase: 'idle', // idle | starting | recording | transcribing | done | error
  lastTranscript: '',
  shortcutErrorKey: '',
  lastErrorKey: '',
  lastErrorVars: null,
  startedAt: 0, // ms, set when the microphone goes live
  lastDurationMs: 0,
  retryNote: null
};

let escapeRegistered = false;

let startTimer = null;
let maxTimer = null;
let hideTimer = null;
let watchdog = null;

/* ------------------------------------------------------------- helpers ---- */

const lang = () => store.read().uiLanguage;
const say = (key, vars) => i18n.t(lang(), key, vars);

function publicState() {
  const settings = store.read();
  return {
    phase: state.phase,
    lastTranscript: state.lastTranscript,
    lastErrorKey: state.lastErrorKey,
    lastErrorVars: state.lastErrorVars,
    shortcut: settings.shortcut,
    shortcutDisplay: accelerator.display(settings.shortcut),
    shortcutErrorKey: state.shortcutErrorKey,
    startedAt: state.startedAt,
    lastDurationMs: state.lastDurationMs,
    silenceStopMs: settings.silenceStopMs,
    retryNote: state.retryNote,
    accent: systemAccent(),
    knownModels: KNOWN_MODELS,
    silenceChoices: SILENCE_CHOICES,
    attemptChoices: ATTEMPT_CHOICES,
    version: app.getVersion(),
    uiLanguage: settings.uiLanguage
  };
}

/* Escape is only grabbed while a recording is running, so it stays available to
 * every other app the rest of the time. */
function setPhase(next) {
  state.phase = next;
  const capturing = next === 'recording' || next === 'starting';
  if (capturing === escapeRegistered) return;
  escapeRegistered = capturing;
  try {
    if (capturing) {
      globalShortcut.register('Escape', () => {
        if (state.phase === 'recording' || state.phase === 'starting') stopRecording();
      });
    } else {
      globalShortcut.unregister('Escape');
    }
    if (process.env.GUYA_DEBUG) console.log(`[guya] escape capture: ${capturing ? 'on' : 'off'}`);
  } catch (_) {
    escapeRegistered = !capturing;
    console.warn('[guya] could not grab the Escape key');
  }
}

function pushPanel() {
  windows.sendToPanel('panel:state', publicState());
}

function clearTimers() {
  clearTimeout(startTimer);
  clearTimeout(maxTimer);
  clearTimeout(watchdog);
  startTimer = null;
  maxTimer = null;
  watchdog = null;
}

function scheduleHide(delayMs) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    windows.hideOverlay();
    if (state.phase === 'done' || state.phase === 'error') {
      setPhase('idle');
      pushPanel();
    }
  }, delayMs);
}

/* Moves the app to the error state.
 *
 * The key travels and the sentence does not: a renderer that is switched to the
 * other language later must still be able to say this in that language, and the
 * overlay has its own dictionary for the few seconds it is on screen. */
function fail(key, vars, options) {
  const config = options || {};
  setPhase('error');
  state.lastErrorKey = key;
  state.lastErrorVars = vars || null;
  clearTimers();
  windows.sendToOverlay({ type: 'flash', state: 'error', messageKey: key, messageVars: vars || null, language: lang() });
  pushPanel();
  if (config.keepOverlay !== true) scheduleHide(config.hideMs || 4500);
  if (config.openPanel) windows.showPanel();
  return { ok: false, errorKey: key, errorVars: vars || null };
}

/* ------------------------------------------------------------ shortcuts ---- */

function registerShortcut(acceleratorString) {
  try {
    globalShortcut.unregister(store.read().shortcut);
  } catch (_) {
    /* nothing registered yet */
  }
  if (!acceleratorString) return { ok: true };
  try {
    const registered = globalShortcut.register(acceleratorString, onHotkey);
    if (!registered) return { ok: false, errorKey: 'error.shortcutTaken' };
    return { ok: true };
  } catch (_) {
    return { ok: false, errorKey: 'error.shortcutInvalid' };
  }
}

function applyShortcut(next) {
  const previous = store.read().shortcut;
  const result = registerShortcut(next);
  if (!result.ok) {
    registerShortcut(previous);
    state.shortcutErrorKey = result.errorKey;
    return result;
  }
  state.shortcutErrorKey = '';
  return { ok: true };
}

function onHotkey() {
  if (state.phase === 'transcribing' || state.phase === 'starting') return;
  if (state.phase === 'recording') stopRecording();
  // startRecording is async; surface a failure in the UI instead of only in the
  // console as an unhandled rejection.
  else
    Promise.resolve(startRecording()).catch((err) => {
      console.warn('[guya] start failed:', err && err.stack ? err.stack : err);
      fail('error.unexpected');
    });
}

/* ------------------------------------------------------------ recording ---- */

async function startRecording() {
  clearTimers();
  clearTimeout(hideTimer);

  const settings = store.read();
  if (!settings.apiKey) {
    windows.showOverlay();
    return fail('error.noKey', null, { openPanel: true, hideMs: 4500 });
  }

  const mic = await systemIntegration.ensureMicrophoneAccess();
  if (!mic.ok) {
    windows.showOverlay();
    return fail(mic.errorKey, null, { openPanel: true, hideMs: 6000 });
  }

  beginRecording();
}

/* One path into a recording: the shortcut, the panel button, the tray-less menu. */
function beginRecording() {
  state.retryNote = '';
  state.overlayShown = true;
  setPhase('starting');
  state.lastErrorKey = '';
  pushPanel();

  /* The window shows the meter itself, so the floating orb is only for when the
   * user is dictating into some other app. */
  state.overlayShown = !windows.panelHasFocus();
  if (state.overlayShown) windows.showOverlay();
  if (process.env.GUYA_DEBUG) {
    console.log(`[guya] overlay ${state.overlayShown ? 'shown' : 'suppressed'} (window in front: ${!state.overlayShown})`);
  }
  warmProviderConnection();
  windows.sendToOverlay({ type: 'start', silenceStopMs: store.read().silenceStopMs });

  // If the renderer never confirms, do not leave the app stuck in "starting".
  startTimer = setTimeout(() => {
    if (state.phase === 'starting') fail('error.micFailed');
  }, 10000);
}

function stopRecording() {
  if (state.phase !== 'recording' && state.phase !== 'starting') return;
  clearTimers();
  setPhase('transcribing');
  pushPanel();
  windows.sendToOverlay({ type: 'stop' });
  // Safety net: the overlay always answers, but never hang the app if it cannot.
  watchdog = setTimeout(() => {
    if (state.phase === 'transcribing') fail('error.timeout');
  }, 150000);
}

async function handleAudioResult(wav, durationMs) {
  if (state.phase !== 'transcribing') return { ok: false };

  const settings = store.read();
  const seconds = durationMs > 0 ? durationMs / 1000 : 0;
  if (seconds < MIN_AUDIO_SECONDS) return fail('error.tooShort');

  const result = await gemini.transcribe({
    apiKey: settings.apiKey,
    model: settings.model,
    wav,
    settings,
    seconds,
    onAttempt: (attempt, total) => {
      state.retryNote = { attempt, total };
      pushPanel();
    }
  });
  state.retryNote = null;

  if (!result.ok) return fail(result.errorKey || 'error.unexpected', result.errorVars);

  setPhase('done');
  state.lastDurationMs = durationMs;
  state.lastTranscript = result.text;
  state.lastErrorKey = '';
  pushPanel();

  if (settings.copyToClipboard || settings.pasteAfterTranscribe) systemIntegration.copy(result.text);

  windows.sendToOverlay({
    type: 'flash',
    state: 'done',
    messageKey: result.truncated ? 'error.truncated' : '',
    language: lang()
  });
  scheduleHide(1100);

  if (settings.pasteAfterTranscribe) {
    // Give the overlay a moment to disappear before typing into the focused app.
    setTimeout(async () => {
      const paste = await systemIntegration.pasteIntoActiveApp();
      if (!paste.ok) {
        state.lastErrorKey = paste.errorKey;
        state.lastErrorVars = null;
        pushPanel();
        if (paste.needsAccessibility) systemIntegration.openPrivacySettings('accessibility');
      }
    }, 350);
  }

  return { ok: true, text: result.text };
}

/* ---------------------------------------------------------------- ipc ----- */

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    settings: store.read(),
    languages: i18n.LANGUAGES,
    knownModels: KNOWN_MODELS,
    silenceChoices: SILENCE_CHOICES,
    platform: process.platform,
    version: app.getVersion(),
    state: publicState()
  }));

  ipcMain.handle('settings:save', (_event, patch) => {
    const before = store.read();
    const clean = Object.assign({}, patch || {});

    let next = store.update(clean);
    let warningKey = '';
    let pasteBlocked = false;

    /* Typing into another app is gated by the system: without its permission the
     * setting cannot be on, so it is refused here instead of failing later. */
    if (next.pasteAfterTranscribe && !systemIntegration.accessibilityStatus().granted) {
      next = store.update({ pasteAfterTranscribe: false });
      pasteBlocked = true;
    }

    if (typeof clean.shortcut === 'string' && clean.shortcut !== before.shortcut) {
      const applied = applyShortcut(next.shortcut);
      if (!applied.ok) {
        // Keep the previously working shortcut active and stored.
        warningKey = applied.errorKey;
        next = store.update({ shortcut: before.shortcut });
      }
    }

    if (typeof clean.launchAtLogin === 'boolean' && clean.launchAtLogin !== before.launchAtLogin) {
      const login = systemIntegration.loginItem(next.launchAtLogin);
      if (!login.ok) warningKey = warningKey || login.errorKey;
    }

    pushPanel();
    return {
      ok: true,
      settings: next,
      pasteBlocked,
      warningKey,
      warning: warningKey ? i18n.t(next.uiLanguage, warningKey) : ''
    };
  });

  ipcMain.handle('models:list', () => gemini.listModels(store.read().apiKey, lang()));

  ipcMain.handle('models:test', (_event, model) => {
    const settings = store.read();
    return gemini.testKey(settings.apiKey, model || settings.model, lang());
  });

  ipcMain.handle('recording:toggle', () => {
    onHotkey();
    return publicState();
  });

  ipcMain.handle('clipboard:copy', (_event, text) => {
    systemIntegration.copy(text);
    return { ok: true };
  });

  ipcMain.handle('system:open-privacy', (_event, kind) => {
    systemIntegration.openPrivacySettings(kind);
    return { ok: true };
  });

  ipcMain.handle('permissions:accessibility', () => systemIntegration.accessibilityStatus());

  /* Makes macOS put up its own dialog for the Accessibility pane. */
  ipcMain.handle('permissions:request-accessibility', () => systemIntegration.requestAccessibility());

  /* ---- called by the overlay renderer ---- */

  /* The overlay owns the microphone, so the panel's meter is fed from there. */
  ipcMain.on('audio:level', (_event, level) => {
    if (typeof level !== 'number' || !Number.isFinite(level)) return;
    const clamped = Math.min(1, Math.max(0, level));
    state.level = clamped;
    windows.sendToPanel('panel:level', clamped);
  });

  ipcMain.handle('audio:ready', () => {
    clearTimeout(startTimer);
    startTimer = null;
    if (state.phase !== 'starting' && state.phase !== 'recording') return { ok: false };
    setPhase('recording');
    state.startedAt = Date.now();
    state.lastErrorKey = '';
    pushPanel();
    maxTimer = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
    return { ok: true };
  });

  ipcMain.handle('audio:error', (_event, errorKey) => {
    windows.showOverlay();
    return fail(typeof errorKey === 'string' && errorKey.indexOf('error.') === 0 ? errorKey : 'error.micFailed', null, {
      openPanel: true,
      hideMs: 6000
    });
  });

  /* The overlay stops a recording on its own when it hears silence. */
  ipcMain.handle('audio:auto-stop', () => {
    if (state.phase !== 'recording' && state.phase !== 'starting') return { ok: false };
    clearTimers();
    setPhase('transcribing');
    pushPanel();
    return { ok: true };
  });

  ipcMain.handle('audio:result', (_event, payload) => {
    // Belt and braces: an overlay-initiated stop must still be transcribed.
    if (state.phase === 'recording' || state.phase === 'starting') {
      clearTimers();
      setPhase('transcribing');
      pushPanel();
    }
    const wav = Buffer.from(payload && payload.wav ? payload.wav : []);
    const durationMs = payload && payload.durationMs ? payload.durationMs : 0;
    // Never let a slow API call block the renderer's invoke channel for long.
    handleAudioResult(wav, durationMs).catch((err) => fail('error.unexpected'));
    return { ok: true };
  });
}

/* -------------------------------------------------------------- startup --- */

function setupApplicationMenu() {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      /* Role menus, so macOS supplies their names in the user's language rather
       * than the app shipping English ones. */
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  );
}

/* Resolving and connecting to the provider takes a few hundred milliseconds; it
 * should happen while the user is still speaking, not after they stop. */
function warmProviderConnection() {
  try {
    session.defaultSession.preconnect({ url: 'https://generativelanguage.googleapis.com', numSockets: 1 });
  } catch (_) {
    /* preconnect is best effort */
  }
}

function allowMicrophoneForOwnPages() {
  const dflt = session.defaultSession;
  // Only our own renderer may touch the microphone.
  const isOwnPage = (webContents) => !!webContents && String(webContents.getURL()).startsWith('app://bundle/');
  dflt.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'media' && isOwnPage(webContents));
  });
  dflt.setPermissionCheckHandler((webContents, permission) => permission === 'media' && isOwnPage(webContents));
}

/* Unpackaged, macOS shows Electron's own icon in the Dock; packaged builds use
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

function start() {
  applyDockIcon();
  appProtocol.install();
  warmProviderConnection();
  allowMicrophoneForOwnPages();
  nativeTheme.themeSource = 'system';
  setupApplicationMenu();

  windows.getOverlay(); // preload the overlay renderer so the first hotkey feels instant
  windows.getPanel();

  registerIpc();

  const shortcut = store.read().shortcut;
  const applied = registerShortcut(shortcut);
  state.shortcutErrorKey = applied.ok ? '' : applied.errorKey;
  if (!applied.ok) console.warn('[guya] shortcut unavailable:', shortcut);

  if (store.read().launchAtLogin) systemIntegration.loginItem(true);

  if (process.env.GUYA_DEBUG) {
    console.log(`[guya] ready — shortcut "${shortcut}"${applied.ok ? '' : ' (UNAVAILABLE)'}, settings at ${store.path}`);
  }

  pushPanel();
  if (!store.read().apiKey) windows.showPanel();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows.showPanel());

  app.whenReady().then(start);

  app.on('activate', () => windows.showPanel());

  // macOS keeps running with the panel closed (dock icon reopens it); on
  // Windows and Linux the app has no other entry point, so closing quits.
  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
    clearTimers();
    clearTimeout(hideTimer);
    globalShortcut.unregisterAll();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
}
