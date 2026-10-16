/*
 * Guya — the recording state.
 *
 * One place decides which phase the app is in and what the renderers are told
 * about it. Messages cross as keys, never as sentences: a renderer that is
 * switched to the other language later must be able to say the same thing there.
 */
'use strict';

const { app } = require('electron');
const store = require('./store');
const windows = require('./windows');
const platform = require('./platform');
const accelerator = require('../shared/accelerator');
const { KNOWN_MODELS, SILENCE_CHOICES, ATTEMPT_CHOICES, NO_SPEECH_CHOICES } = require('../shared/defaults');

const state = {
  phase: 'idle', // idle | starting | recording | transcribing | done | error
  lastTranscript: '',
  shortcutErrorKey: '',
  lastErrorKey: '',
  lastErrorVars: null,
  startedAt: 0, // ms, set when the microphone goes live
  lastDurationMs: 0,
  retryNote: null,
  overlayShown: true
};

/* Moving between phases is the one event other modules need to hear about: the
 * shortcut module grabs Escape for exactly as long as a recording is running. */
const phaseListeners = [];

function onPhaseChange(listener) {
  phaseListeners.push(listener);
}

function setPhase(next) {
  const previous = state.phase;
  state.phase = next;
  if (previous === next) return;
  phaseListeners.forEach((listener) => listener(next, previous));
}

/* Everything a renderer needs to draw itself, as plain data. */
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
    platform: process.platform,
    accent: platform.systemAccent(),
    knownModels: KNOWN_MODELS,
    silenceChoices: SILENCE_CHOICES,
    noSpeechChoices: NO_SPEECH_CHOICES,
    attemptChoices: ATTEMPT_CHOICES,
    version: app.getVersion(),
    uiLanguage: settings.uiLanguage
  };
}

function pushPanel() {
  windows.sendToPanel('panel:state', publicState());
}

module.exports = { state, setPhase, onPhaseChange, publicState, pushPanel };
