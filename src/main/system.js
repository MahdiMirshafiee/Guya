/* OS-level integration: clipboard, "paste into the active app", microphone
 * permission, login item. Each platform gets the cheapest built-in mechanism so
 * the app stays free of native modules. */
'use strict';

const { app, clipboard, systemPreferences, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function copy(text) {
  if (typeof text === 'string' && text.length) clipboard.writeText(text);
}

/* macOS and Windows both keep a login item for the app themselves. Linux does not: a
 * desktop there starts an application from a `~/.config/autostart` entry the desktop
 * environment owns, which is why Electron's own call does nothing there. Reporting
 * success for a switch that cannot work is the one thing worse than not offering it —
 * the user turns it on, sees it on, and the app is never there after a login. */
/* Pure, so it can be tested from a machine that is none of these. */
function loginItemRefusal(platform, packaged) {
  if (!packaged) return 'error.loginItemPackagedOnly';
  if (platform !== 'darwin' && platform !== 'win32') return 'error.loginItemUnsupported';
  return null;
}

/* The argument the login item is registered with, so the app can tell "a person started
 * me" from "the system started me at login" — on Windows there is no other way to know,
 * and the difference decides whether a window opens. */
const HIDDEN_ARG = '--hidden';

/* Pure: what the system is told when the login item is set. The argument is how the app
 * tells "a person started me" from "the system started me at login" on Windows, and on a
 * portable build the path is the launcher the user actually has rather than the copy the
 * launcher deletes on exit. */
function loginItemOptions(openAtLogin, platform, portablePath) {
  const options = { openAtLogin: !!openAtLogin, openAsHidden: true };
  if (platform === 'win32') {
    options.args = [HIDDEN_ARG];
    if (portablePath) options.path = portablePath;
  }
  return options;
}

function loginItem(openAtLogin) {
  const refusal = loginItemRefusal(process.platform, app.isPackaged);
  if (refusal) return { ok: false, errorKey: refusal };
  try {
    app.setLoginItemSettings(loginItemOptions(openAtLogin, process.platform, process.env.PORTABLE_EXECUTABLE_FILE));
    return { ok: true };
  } catch (err) {
    return { ok: false, errorKey: 'error.unexpected' };
  }
}

/* Whether this start was the login item's doing rather than the user's. macOS answers it
 * directly; on Windows the answer is the argument the item was registered with. */
function startedAtLogin() {
  if (process.platform === 'darwin') {
    try {
      return app.getLoginItemSettings().wasOpenedAtLogin === true;
    } catch (_) {
      return false;
    }
  }
  return process.argv.indexOf(HIDDEN_ARG) !== -1;
}

/* One address the app may open, and only this one: the page that hands out the API key
 * the window tells the user to get. A general "open this URL" door in the renderer is a
 * door for anything that ever gets into the renderer. */
const AI_STUDIO_URL = 'https://aistudio.google.com/apikey';

function openExternal(what) {
  if (what !== 'aistudio') return Promise.resolve({ ok: false });
  if (process.env.GUYA_DEBUG) console.log('[guya] opening the key page');
  return shell.openExternal(AI_STUDIO_URL);
}

/* Typing into another app is a keystroke through the OS, and each system exposes
 * it differently: AppleScript on macOS, SendKeys on Windows, and on Linux a small
 * helper the user installs. X11 has xdotool; Wayland has ydotool and wtype. */
const LINUX_TOOLS = [
  { name: 'xdotool', session: 'x11', args: ['key', '--clearmodifiers', 'ctrl+v'] },
  { name: 'ydotool', session: 'wayland', args: ['key', '29:1', '47:1', '47:0', '29:0'] },
  { name: 'wtype', session: 'wayland', args: ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'] }
];

function commandExists(command) {
  /* The environment variable must not be called `path`: it shadowed the module, so
   * `path.join` threw inside the try and every command was reported as missing —
   * which is how a Linux install with xdotool never got automatic paste. */
  return (process.env.PATH || '').split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch (_) {
      return false;
    }
  });
}

/* Pure, so it can be tested without touching the machine. */
function choosePasteTool(available, wayland) {
  const order = wayland ? ['ydotool', 'wtype', 'xdotool'] : ['xdotool', 'ydotool', 'wtype'];
  const name = order.find((candidate) => available.indexOf(candidate) !== -1);
  return LINUX_TOOLS.find((tool) => tool.name === name) || null;
}

/* What this machine can do, so the interface can say it instead of guessing. */
function pasteSupport() {
  if (IS_MAC) return { supported: true, tool: 'osascript' };
  if (IS_WIN) return { supported: true, tool: 'powershell' };
  const available = LINUX_TOOLS.filter((tool) => commandExists(tool.name)).map((tool) => tool.name);
  const tool = choosePasteTool(available, !!process.env.WAYLAND_DISPLAY);
  return { supported: !!tool, tool: tool ? tool.name : null };
}

/* Types the clipboard content into whatever app currently has focus. Returns
 * i18n keys so the caller can localize. */
/* Why a keystroke was refused, as a key the window can explain.
 *
 * macOS asks for two different permissions and refuses in two different ways: sending
 * keystrokes at all is Accessibility (-1002 / "not allowed assistive"), while asking
 * System Events to do it is Automation (-1743 / "not allowed to send Apple events").
 * Both were reported as Accessibility, so a user who had granted one and not the other
 * was sent to a pane that could not fix it — which is a paste that never works however
 * many times the switch is turned on. */
function pasteFailureKey(message) {
  if (/1002|not allowed assistive|accessibility/i.test(message)) {
    return { errorKey: 'error.pastePermission', needsAccessibility: true };
  }
  if (/-1743|apple events|automation/i.test(message)) {
    return { errorKey: 'error.pasteAutomation', needsAutomation: true };
  }
  return { errorKey: 'error.pasteFailed' };
}

function pasteIntoActiveApp() {
  return new Promise((resolve) => {
    if (IS_MAC) {
      execFile(
        'osascript',
        /* A key code rather than `keystroke "v"`: keystroke types the character with a
         * modifier held, which apps are free to treat as text, and several do — the
         * symptom is a paste that lands beside the caret instead of at it. Key code 9
         * is the V key, sent as the key it is. */
        ['-e', 'tell application "System Events" to key code 9 using command down'],
        { timeout: 5000 },
        (err, _stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          const message = String((stderr || '') + (err && err.message ? err.message : ''));
          resolve(Object.assign({ ok: false }, pasteFailureKey(message)));
        }
      );
      return;
    }

    if (IS_WIN) {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', "$ws = New-Object -ComObject WScript.Shell; $ws.SendKeys('^v')"],
        { timeout: 5000, windowsHide: true },
        (err) => resolve(err ? { ok: false, errorKey: 'error.pasteFailed' } : { ok: true })
      );
      return;
    }

    const tool = choosePasteTool(
      LINUX_TOOLS.filter((candidate) => commandExists(candidate.name)).map((candidate) => candidate.name),
      !!process.env.WAYLAND_DISPLAY
    );
    if (!tool) return resolve({ ok: false, errorKey: 'error.pasteNeedsTool' });
    execFile(tool.name, tool.args, { timeout: 5000 }, (err) =>
      resolve(err ? { ok: false, errorKey: 'error.pasteFailed' } : { ok: true })
    );
  });
}

/* Returns { ok } or { ok:false, errorKey, needsSettings }. */
async function ensureMicrophoneAccess() {
  if (process.platform === 'linux') return { ok: true };
  /* Only the automated end-to-end harness sets this: it runs with Chromium's fake
   * capture device, and macOS still enforces the real permission at capture time. */
  if (process.env.GUYA_SKIP_MIC_PREFLIGHT === '1') return { ok: true };
  let status = 'granted';
  try {
    status = systemPreferences.getMediaAccessStatus('microphone');
  } catch (_) {
    return { ok: true };
  }

  /* Only "denied" and "restricted" are answers that mean the system will refuse the
   * capture: the user turned the microphone off for the app, or a policy did. Anything
   * else — including the "unknown" Windows reports before the question has been asked —
   * means it has not been put yet, and the way to put it is to open the device. Refusing
   * on those told a Windows user their microphone was turned off when it was not, with
   * nothing to click and nothing to fix. */
  const refused = status === 'denied' || status === 'restricted';
  if (!refused) {
    if (IS_MAC && status === 'not-determined') {
      try {
        if (await systemPreferences.askForMediaAccess('microphone')) return { ok: true };
        return { ok: false, errorKey: 'error.micDenied', needsSettings: true };
      } catch (_) {
        /* fall through: asking failed, and the capture path will have its own say */
      }
    }
    return { ok: true };
  }
  return { ok: false, errorKey: 'error.micDenied', needsSettings: true };
}

/* Accessibility is what lets the app type into another app. macOS owns the
 * permission, so the app asks the system rather than guessing. */
function accessibilityStatus() {
  if (!IS_MAC) return { granted: true };
  try {
    return { granted: systemPreferences.isTrustedAccessibilityClient(false) };
  } catch (_) {
    return { granted: false, unknown: true };
  }
}

/* `true` makes macOS put up its own dialog for the pane, which is the only way
 * the user is ever told in the system's own words. */
function requestAccessibility() {
  if (!IS_MAC) return { granted: true };
  let granted = false;
  try {
    granted = systemPreferences.isTrustedAccessibilityClient(true);
  } catch (_) {
    granted = false;
  }
  const status = accessibilityStatus();
  return { granted: status.granted, prompted: !status.granted };
}

/* The Automation list lives in a pane of its own, next to Accessibility. */
function openPrivacySettings(kind) {
  if (IS_MAC) {
    const panes = {
      accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
      automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
      microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
    };
    const pane = panes[kind] || panes.microphone;
    return shell.openExternal(pane);
  }
  if (IS_WIN) {
    /* Windows has no Automation pane and no Accessibility pane as macOS means it: the
     * keyboard page under Ease of Access is the nearest thing, and the microphone has a
     * page of its own. The line used to send everything but "accessibility" to the
     * microphone page, which is not where a refused keystroke is fixed. */
    const page = kind === 'microphone' ? 'ms-settings:privacy-microphone' : 'ms-settings:easeofaccess-keyboard';
    return shell.openExternal(page);
  }
  return Promise.resolve();
}

module.exports = { copy, pasteIntoActiveApp, pasteSupport, choosePasteTool, pasteFailureKey, accessibilityStatus, requestAccessibility, ensureMicrophoneAccess, openPrivacySettings, loginItem, loginItemRefusal, loginItemOptions, startedAtLogin, openExternal, HIDDEN_ARG };
