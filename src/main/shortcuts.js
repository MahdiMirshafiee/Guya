/*
 * Guya — the global shortcut, and Escape for exactly as long as it is needed.
 */
'use strict';

const { globalShortcut } = require('electron');
const store = require('./store');
const { state, onPhaseChange } = require('./state');
const recorder = require('./recorder');

const ESCAPE = 'Escape';
let escapeRegistered = false;

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

/* Escape belongs to whatever app the user is in, except while they are dictating
 * here — so it is grabbed on the way into a recording and released on the way out. */
onPhaseChange((phase) => {
  const capturing = phase === 'recording' || phase === 'starting';
  if (capturing === escapeRegistered) return;
  escapeRegistered = capturing;
  try {
    if (capturing) globalShortcut.register(ESCAPE, () => recorder.onHotkey());
    else globalShortcut.unregister(ESCAPE);
    if (process.env.GUYA_DEBUG) console.log(`[guya] escape capture: ${capturing ? 'on' : 'off'}`);
  } catch (_) {
    escapeRegistered = !capturing;
    console.warn('[guya] could not grab the Escape key');
  }
});

module.exports = { registerShortcut, applyShortcut };
