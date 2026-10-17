/*
 * Guya — the global shortcut, and Escape for exactly as long as it is needed.
 */
'use strict';

const { globalShortcut } = require('electron');
const store = require('./store');
const { state, onPhaseChange } = require('./state');
const recorder = require('./recorder');

const ESCAPE = 'Escape';
/* Set GUYA_DEBUG=1 to watch the grab come and go; the end-to-end suite reads it. */
const DEB = !!process.env.GUYA_DEBUG;
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
 * something the user is waiting on — recording, opening the microphone, or waiting for
 * the provider. While waiting there is no other way out.
 *
 * Wayland is the one desktop where this cannot be promised: a client there cannot grab a
 * key, and the portal that stands in for grabbing hands out combinations the user picked
 * in the desktop's own dialog rather than a bare Escape. Everywhere else it is grabbed and
 * released with the phase. Where it cannot be, the shortcut itself still stops the
 * recording, and so does the silence timer. */
const ESCAPE_GRABBABLE = !(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY);

onPhaseChange((phase) => {
  const holding = phase === 'recording' || phase === 'starting' || phase === 'transcribing';
  if (holding === escapeRegistered) return;
  escapeRegistered = holding;
  if (!ESCAPE_GRABBABLE) {
    if (DEB) console.log('[guya] escape capture: not possible on Wayland');
    return;
  }
  try {
    if (!holding) {
      globalShortcut.unregister(ESCAPE);
      if (DEB) console.log('[guya] escape capture: off');
      return;
    }
    /* The return value is the answer, and it fails without throwing: another app can
     * already hold Escape. Recording that as captured would mean never trying again. */
    if (!globalShortcut.register(ESCAPE, () => recorder.onEscape())) {
      escapeRegistered = false;
      if (DEB) console.log('[guya] escape capture: unavailable (another app holds it)');
      return;
    }
    if (DEB) console.log('[guya] escape capture: on');
  } catch (_) {
    escapeRegistered = !holding;
    console.warn('[guya] could not grab the Escape key');
  }
});

module.exports = { registerShortcut, applyShortcut };
