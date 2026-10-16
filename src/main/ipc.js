/*
 * Guya — the IPC contract, in one file.
 *
 * Handlers stay thin: they read the request, call the module that owns the
 * behaviour, and answer. Anything a renderer can ask for is listed here.
 */
'use strict';

const { ipcMain, app } = require('electron');
const store = require('./store');
const gemini = require('./gemini');
const windows = require('./windows');
const systemIntegration = require('./system');
const state_ = require('./state');
const recorder = require('./recorder');
const shortcutApi = require('./shortcuts');
const i18n = require('../shared/i18n');
const { KNOWN_MODELS, SILENCE_CHOICES, ATTEMPT_CHOICES, NO_SPEECH_CHOICES } = require('../shared/defaults');

const lang = () => store.read().uiLanguage;

function register() {
  /* ---- the panel ---- */

  ipcMain.handle('app:info', () => ({
    settings: store.read(),
    languages: i18n.LANGUAGES,
    knownModels: KNOWN_MODELS,
    silenceChoices: SILENCE_CHOICES,
    noSpeechChoices: NO_SPEECH_CHOICES,
    attemptChoices: ATTEMPT_CHOICES,
    platform: process.platform,
    version: app.getVersion(),
    state: state_.publicState()
  }));

  ipcMain.handle('settings:save', (_event, patch) => {
    const before = store.read();
    const clean = Object.assign({}, patch || {});

    let next = store.update(clean);
    /* A save that did not reach the disk is not a save: the window says so rather
     * than showing a value that will be gone at the next launch. */
    let warningKey = next.ok === false ? 'error.unexpected' : '';
    let pasteBlocked = false;

    /* Typing into another app is gated by the system: without its permission the
     * setting cannot be on, so it is refused here instead of failing later. */
    if (next.pasteAfterTranscribe && !systemIntegration.accessibilityStatus().granted) {
      next = store.update({ pasteAfterTranscribe: false });
      pasteBlocked = true;
    }

    if (typeof clean.shortcut === 'string' && clean.shortcut !== before.shortcut) {
      const applied = shortcutApi.applyShortcut(next.shortcut);
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

    state_.pushPanel();
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
    recorder.onHotkey();
    return state_.publicState();
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

  /* Availability can change while the app is closed (a tool gets installed), so
   * it is asked again every time the settings screen is opened. */
  ipcMain.handle('permissions:paste', () => systemIntegration.pasteSupport());

  /* ---- the overlay ---- */

  /* The overlay owns the microphone, so the panel's meter is fed from there: one
   * value per frequency band, in band order. */
  ipcMain.on('audio:spectrum', (_event, levels) => {
    if (!Array.isArray(levels)) return;
    const clean = [];
    for (let i = 0; i < levels.length; i++) {
      const value = levels[i];
      if (typeof value !== 'number' || !Number.isFinite(value)) return;
      clean.push(Math.min(1, Math.max(0, value)));
    }
    if (!clean.length) return;
    windows.sendToPanel('panel:spectrum', clean);
  });

  ipcMain.handle('audio:ready', () => recorder.confirmStarted());
  ipcMain.handle('audio:auto-stop', (_event, reason) => recorder.stopFromOverlay(reason));
  ipcMain.handle('audio:error', (_event, errorKey) => recorder.reportMicFailure(errorKey));
  ipcMain.handle('recording:cancel', () => {
    recorder.cancelSession();
    return state_.publicState();
  });

  ipcMain.handle('audio:result', (_event, payload) => {
    const bytes = payload && payload.wav;
    const usable = bytes instanceof Uint8Array || bytes instanceof ArrayBuffer || Buffer.isBuffer(bytes);
    const durationMs = payload && payload.durationMs;
    if (!usable || !Number.isFinite(durationMs) || durationMs < 0) {
      return recorder.fail('error.unexpected');
    }
    const wav = Buffer.from(bytes);
    const voiceMs = Number.isFinite(payload.voiceMs) ? payload.voiceMs : durationMs;
    const trimmedMs = Number.isFinite(payload.trimmedMs) ? payload.trimmedMs : durationMs;
    // Never let a slow API call block the renderer's invoke channel for long.
    recorder.handleAudioResult(wav, durationMs, voiceMs, trimmedMs).catch(() => recorder.fail('error.unexpected'));
    return { ok: true };
  });
}

module.exports = { register };
