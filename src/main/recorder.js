/*
 * Guya — a dictation session: capture, transcription, and the paths out of it.
 *
 * The phase itself lives in ./state; this module is the flow, the timers and the
 * failures, so there is exactly one place to read when a recording misbehaves.
 */
'use strict';

const store = require('./store');
const windows = require('./windows');
const gemini = require('./gemini');
const systemIntegration = require('./system');
const { state, setPhase, publicState, pushPanel } = require('./state');
const { MAX_RECORDING_MS } = require('../shared/defaults');

const MIN_AUDIO_SECONDS = 0.35;
/* How much of the recording has to have been above the room's own level before it
 * is worth asking a model about, in two parts: enough of it in total to be a word
 * or two, and enough of it in proportion to be speech rather than a door closing.
 * The proportion is what a single bang in an otherwise silent recording fails.
 * Deliberately generous — refusing a real recording is worse than the occasional
 * quiet one reaching the provider, which is why the model is also asked whether it
 * heard anything. */
const MIN_VOICE_MS = 300;
const MIN_SPEECH_RATIO = 0.12;

let startTimer = null; // the microphone never confirmed
let maxTimer = null; // a recording that ran too long
let watchdog = null; // a transcription that never answered
let hideTimer = null; // the overlay saying goodbye

function clearTimers() {
  clearTimeout(startTimer);
  clearTimeout(maxTimer);
  clearTimeout(watchdog);
  startTimer = null;
  maxTimer = null;
  watchdog = null;
}

/* The overlay shows the result for a moment, then goes away on its own. */
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

function cancelHide() {
  clearTimeout(hideTimer);
  hideTimer = null;
}

/*
 * Moves to the error state. The key travels and the sentence does not: a renderer
 * switched to the other language later must still be able to say this, and the
 * overlay has its own dictionary for the few seconds it is on screen.
 */
function fail(key, vars, options) {
  const config = options || {};
  setPhase('error');
  state.lastErrorKey = key;
  state.lastErrorVars = vars || null;
  clearTimers();
  windows.sendToOverlay({ type: 'flash', state: 'error', messageKey: key, messageVars: vars || null, language: store.read().uiLanguage });
  pushPanel();
  if (config.keepOverlay !== true) scheduleHide(config.hideMs || 4500);
  if (config.openPanel) windows.showPanel();
  return { ok: false, errorKey: key, errorVars: vars || null };
}

/* ------------------------------------------------------------ the flow ---- */

async function startRecording() {
  cancelHide();
  clearTimers();

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

/* Shared by the shortcut, the panel button and the wake-less menu. */
function beginRecording() {
  state.retryNote = '';
  state.overlayShown = true;
  state.lastErrorKey = '';
  state.lastErrorVars = null;
  setPhase('starting');
  pushPanel();

  /* The window shows the meter itself, so the floating orb is only for when the
   * user is dictating into some other app. */
  state.overlayShown = !windows.panelHasFocus();

  /* Start comes before the window: opening the microphone is the slow part, and
   * nothing should wait behind it. */
  windows.sendToOverlay({ type: 'start', silenceStopMs: store.read().silenceStopMs });
  if (state.overlayShown) windows.showOverlay();
  if (process.env.GUYA_DEBUG) {
    console.log(`[guya] overlay ${state.overlayShown ? 'shown' : 'suppressed'} (window in front: ${!state.overlayShown})`);
  }
  gemini.warm();

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
  // The overlay always answers, but never hang the app if it cannot.
  watchdog = setTimeout(() => {
    if (state.phase === 'transcribing') fail('error.timeout');
  }, 150000);
}

function onHotkey() {
  if (state.phase === 'transcribing' || state.phase === 'starting') return;
  if (state.phase === 'recording') stopRecording();
  // startRecording is async; surface a failure in the UI instead of only in the
  // console as an unhandled rejection.
  else Promise.resolve(startRecording()).catch((err) => {
    console.warn('[guya] could not start recording:', err && err.stack ? err.stack : err);
    fail('error.unexpected');
  });
}

async function handleAudioResult(wav, durationMs, voiceMs) {
  if (state.phase !== 'transcribing') return { ok: false };

  const settings = store.read();
  const seconds = durationMs > 0 ? durationMs / 1000 : 0;
  if (seconds < MIN_AUDIO_SECONDS) return fail('error.tooShort');

  /* A recording of a quiet room is not a question, and a model asked to transcribe
   * one will answer with something plausible instead — a greeting, a thank-you, a
   * sentence nobody said, in a language nobody spoke. So it never gets asked: the
   * overlay measures how much of the recording was above the room's own level, and
   * below these two thresholds there is nothing to transcribe. Silence is a result,
   * not a failure to hide. */
  const spoken = Number.isFinite(voiceMs) ? voiceMs : durationMs;
  const ratio = durationMs > 0 ? spoken / durationMs : 1;
  if (process.env.GUYA_DEBUG) {
    console.log(`[guya] recording: ${Math.round(durationMs)}ms, ${Math.round(spoken)}ms above the room (${Math.round(ratio * 100)}%)`);
  }
  if (spoken < MIN_VOICE_MS || ratio < MIN_SPEECH_RATIO) return fail('error.noSpeech');

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
  state.lastErrorVars = null;
  pushPanel();

  if (settings.copyToClipboard || settings.pasteAfterTranscribe) systemIntegration.copy(result.text);

  windows.sendToOverlay({
    type: 'flash',
    state: 'done',
    messageKey: result.truncated ? 'error.truncated' : '',
    language: settings.uiLanguage
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

/* The overlay confirms the microphone is live, which is what starts the clock. */
function confirmStarted() {
  if (state.phase !== 'starting' && state.phase !== 'recording') return { ok: false };
  clearTimeout(startTimer);
  startTimer = null;
  setPhase('recording');
  state.startedAt = Date.now();
  state.lastErrorKey = '';
  pushPanel();
  maxTimer = setTimeout(() => stopRecording(), MAX_RECORDING_MS);
  return { ok: true };
}

/* The overlay stops itself when it hears nothing for long enough. */
function stopFromOverlay() {
  if (state.phase !== 'recording' && state.phase !== 'starting') return { ok: false };
  clearTimers();
  setPhase('transcribing');
  pushPanel();
  return { ok: true };
}

/* A microphone that never opened ends the session the same way. */
function reportMicFailure(errorKey) {
  windows.showOverlay();
  return fail(typeof errorKey === 'string' && errorKey.indexOf('error.') === 0 ? errorKey : 'error.micFailed', null, {
    openPanel: true,
    hideMs: 6000
  });
}

module.exports = {
  onHotkey,
  startRecording,
  confirmStarted,
  stopFromOverlay,
  beginRecording,
  stopRecording,
  handleAudioResult,
  reportMicFailure,
  fail,
  scheduleHide,
  cancelHide,
  clearTimers
};
