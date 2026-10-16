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

/* The accelerator that is registered with the system right now. Tracked here, never
 * read back from the settings store: the store already holds the NEW value by the time
 * this runs, so reading it would unregister the key the user just asked for and leave
 * the previous one held forever. */
let active = '';

function restore(previous) {
  if (!previous) return;
  try {
    if (globalShortcut.register(previous, recorder.onHotkey)) active = previous;
  } catch (_) {
    /* nothing more can be done */
  }
}

function registerShortcut(next) {
  const previous = active;
  if (previous) {
    try {
      globalShortcut.unregister(previous);
    } catch (_) {
      /* already gone */
    }
    active = '';
  }
  if (!next) return { ok: true };
  try {
    if (!globalShortcut.register(next, recorder.onHotkey)) {
      restore(previous);
      return { ok: false, errorKey: 'error.shortcutTaken' };
    }
    active = next;
    return { ok: true };
  } catch (_) {
    restore(previous);
    return { ok: false, errorKey: 'error.shortcutInvalid' };
  }
}

function applyShortcut(next) {
  const result = registerShortcut(next);
  state.shortcutErrorKey = result.ok ? '' : result.errorKey;
  return result;
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
