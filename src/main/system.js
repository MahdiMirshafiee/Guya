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

function loginItem(openAtLogin) {
  if (!app.isPackaged) return { ok: false, errorKey: 'error.loginItemPackagedOnly' };
  try {
    app.setLoginItemSettings({ openAtLogin: !!openAtLogin, openAsHidden: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, errorKey: 'error.unexpected' };
  }
}

function loginItemState() {
  if (!app.isPackaged) return false;
  try {
    return !!app.getLoginItemSettings().openAtLogin;
  } catch (_) {
    return false;
  }
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
  const path = process.env.PATH || '';
  return path.split(':').some((dir) => {
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
function pasteIntoActiveApp() {
  return new Promise((resolve) => {
    if (IS_MAC) {
      execFile(
        'osascript',
        ['-e', 'tell application "System Events" to keystroke "v" using command down'],
        { timeout: 5000 },
        (err, _stdout, stderr) => {
          if (!err) return resolve({ ok: true });
          const message = String((stderr || '') + (err && err.message ? err.message : ''));
          if (message.includes('-1743') || /not allowed assistive/i.test(message)) {
            return resolve({ ok: false, errorKey: 'error.pastePermission', needsAccessibility: true });
          }
          resolve({ ok: false, errorKey: 'error.pasteFailed' });
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
  if (status === 'granted') return { ok: true };

  if (IS_MAC && status === 'not-determined') {
    try {
      const granted = await systemPreferences.askForMediaAccess('microphone');
      if (granted) return { ok: true };
    } catch (_) {
      /* fall through to the denied branch */
    }
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

function openPrivacySettings(kind) {
  if (IS_MAC) {
    const pane =
      kind === 'accessibility'
        ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
        : 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
    return shell.openExternal(pane);
  }
  if (IS_WIN) {
    const page = kind === 'accessibility' ? 'ms-settings:easeofaccess-keyboard' : 'ms-settings:privacy-microphone';
    return shell.openExternal(page);
  }
  return Promise.resolve();
}

module.exports = { copy, pasteIntoActiveApp, pasteSupport, choosePasteTool, accessibilityStatus, requestAccessibility, ensureMicrophoneAccess, openPrivacySettings, loginItem, loginItemState };
