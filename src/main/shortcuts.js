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
    const registered = globalShortcut.register(acceleratorString, recorder.onHotkey);
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

/* Escape belongs to whatever app the user is in, except while this app is doing
 * something the user is waiting on — recording, opening the microphone, or waiting
 * for the provider. While waiting there is no other way out. */
onPhaseChange((phase) => {
  const holding = phase === 'recording' || phase === 'starting' || phase === 'transcribing';
  if (holding === escapeRegistered) return;
  escapeRegistered = holding;
  try {
    if (holding) globalShortcut.register(ESCAPE, () => recorder.onEscape());
    else globalShortcut.unregister(ESCAPE);
    if (process.env.GUYA_DEBUG) console.log(`[guya] escape capture: ${holding ? 'on' : 'off'}`);
  } catch (_) {
    escapeRegistered = !holding;
    console.warn('[guya] could not grab the Escape key');
  }
});

module.exports = { registerShortcut, applyShortcut };
