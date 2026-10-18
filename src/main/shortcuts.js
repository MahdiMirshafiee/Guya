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

/* Puts the previous key back after a change that did not work out, and says whether it
 * worked: another app can have taken that combination in the meantime, and then the app
 * has no shortcut at all — which the window has to hear about rather than showing a key
 * that is not held. */
function restore(previous) {
  if (!previous) return true;
  try {
    if (globalShortcut.register(previous, recorder.onHotkey)) {
      active = previous;
      return true;
    }
    console.warn('[guya] the previous shortcut could not be put back:', previous);
  } catch (err) {
    console.warn('[guya] the previous shortcut could not be put back:', err && err.message);
  }
  return false;
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
      return { ok: false, errorKey: 'error.shortcutTaken', restored: restore(previous) };
    }
    active = next;
    return { ok: true };
  } catch (_) {
    return { ok: false, errorKey: 'error.shortcutInvalid', restored: restore(previous) };
  }
}

function applyShortcut(next) {
  const result = registerShortcut(next);
  state.shortcutErrorKey = result.ok ? '' : result.errorKey;
  state.shortcutHeld = result.ok;
  return result;
}

/* The key the app is holding is not the user's to press while they are choosing a new one:
 * Windows hands the combination to whoever registered it before the window ever sees the
 * keystroke, so a field waiting for keys receives none — which is what "I press keys and
 * nothing happens" was. Electron has this exact switch for this exact screen.
 *
 * A Wayland session cannot suspend anything (the grab is the desktop's), and there the
 * capture is left as it was. */
/* Pure, so the one platform where this cannot work can be tested from the others. */
function canSuspendCapture(platform, wayland) {
  return !(platform === 'linux' && wayland);
}

function suspendCapture(suspended) {
  const wayland = !!(process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY);
  if (!canSuspendCapture(process.platform, wayland)) return { ok: true, suspended: false };
  try {
    globalShortcut.setSuspended(!!suspended);
    return { ok: true, suspended: !!suspended };
  } catch (err) {
    console.warn('[guya] could not suspend the shortcut while choosing one:', err && err.message);
    return { ok: false };
  }
}

/* Asked again when the window is opened: the combination may have been taken by another
 * app for a while and given back, and there is nothing else the user can press. */
function retry() {
  const wanted = store.read().shortcut;
  if (!wanted || active === wanted) {
    state.shortcutHeld = !wanted ? false : true;
    return { ok: true, held: !!wanted && active === wanted };
  }
  const result = registerShortcut(wanted);
  state.shortcutErrorKey = result.ok ? '' : result.errorKey;
  state.shortcutHeld = result.ok;
  if (!result.ok && process.env.GUYA_DEBUG) console.log('[guya] the shortcut is still unavailable:', wanted, result.errorKey);
  return { ok: result.ok, held: result.ok, errorKey: result.errorKey };
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

module.exports = { registerShortcut, applyShortcut, suspendCapture, canSuspendCapture, retry };
