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
  let result;
  try {
    globalShortcut.setSuspended(!!suspended);
    result = { ok: true, suspended: !!suspended };
  } catch (err) {
    console.warn('[guya] could not suspend the shortcut while choosing one:', err && err.message);
    result = { ok: false, suspended: false };
  }
  /* Lifting the suspension re-registers what Electron had stored. If that did not take —
   * the combination taken meanwhile, a platform that does not put them back — the app is
   * holding nothing and the user's next press does nothing at all. */
  if (!suspended) {
    const held = ensureHeld();
    if (!held.held && process.env.GUYA_DEBUG) console.log('[guya] the shortcut did not come back after the capture');
  }
  return result;
}

/* The key the app is supposed to be holding, asked for again — after every phase change,
 * after a capture in the settings screen, and whenever the window is opened. A registration
 * can be lost without anything asking for it (another app taking the combination for a
 * while, a desktop session change, a suspension that ended badly), and the user has no way
 * to press anything that tells them so: the shortcut simply stops working mid-recording,
 * which is what "I press it again to stop and nothing happens" is.
 *
 * Cheap when nothing is wrong: one lookup, no window, no IPC. */
function ensureHeld() {
  const wanted = active || store.read().shortcut;
  if (!wanted) {
    state.shortcutHeld = false;
    return { ok: true, held: false };
  }
  let held = false;
  try {
    held = globalShortcut.isRegistered(wanted);
  } catch (_) {
    held = false;
  }
  if (held) {
    state.shortcutHeld = true;
    state.shortcutErrorKey = '';
    return { ok: true, held: true };
  }
  if (process.env.GUYA_DEBUG) console.log('[guya] the shortcut is not held any more; taking it again:', wanted);
  const result = registerShortcut(wanted);
  state.shortcutHeld = result.ok;
  state.shortcutErrorKey = result.ok ? '' : result.errorKey;
  return { ok: result.ok, held: result.ok, errorKey: result.errorKey, regained: result.ok };
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

/* While the microphone is open, the key is checked now and then rather than only when the
 * phase changes: the press the user is about to make — "the same key again, to stop" — is
 * the one a lost registration takes away, and the phase does not change between those two
 * presses. Cheap: a table lookup, nothing else, and it says nothing unless the key really
 * had gone. */
const KEY_CHECK_MS = 2000;
let keyWatch = null;

function watchWhileRecording(watching) {
  if (watching && !keyWatch) keyWatch = setInterval(ensureHeld, KEY_CHECK_MS);
  else if (!watching && keyWatch) {
    clearInterval(keyWatch);
    keyWatch = null;
  }
}

onPhaseChange((phase) => {
  /* A phase change is the moment the app is doing something the user asked for with a key:
   * if the key went missing between two presses, this is where it comes back. */
  ensureHeld();
  const holding = phase === 'recording' || phase === 'starting' || phase === 'transcribing';
  watchWhileRecording(phase === 'recording' || phase === 'starting');
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

/* Nothing should keep a timer alive past the app's own end. */
function stopWatching() {
  watchWhileRecording(false);
}

module.exports = { registerShortcut, applyShortcut, suspendCapture, canSuspendCapture, ensureHeld, stopWatching };
