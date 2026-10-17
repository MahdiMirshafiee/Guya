/*
 * End-to-end check for the whole app: it launches Guya itself against a throwaway
 * profile with Chromium's fake microphone, drives it over the DevTools protocol,
 * and asserts what a user would see. Run with `npm run e2e`.
 *
 * It is deliberately black-box: nothing in the app knows about this file except
 * the documented GUYA_SKIP_MIC_PREFLIGHT switch, which only skips the macOS
 * permission *advice* — the system still enforces the permission when capture
 * actually starts.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const i18n = require('../src/shared/i18n.js');
const GuyaPrompt = require('../src/shared/prompt.js');
/* The header carries the app's name in whichever language the window is in. The
 * test does not care which, only that it is the name and not a task sentence. */
const APP_TITLES = ['fa', 'en'].map((lang) => i18n.t(lang, 'ui.title'));
const PORT = 9300 + Math.floor(Math.random() * 500);

/* The harness drives the app over the DevTools protocol with the global
 * WebSocket, which only exists from Node 22 — say so here rather than dying three
 * frames deep in the connection code. */
if (typeof WebSocket !== 'function') {
  console.error(`Guya's e2e needs Node 22 or newer (this is ${process.version}); it talks to the app over the DevTools protocol.`);
  process.exit(1);
}
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'guya-e2e-'));
const LOG = path.join(PROFILE, 'app.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let app = null;
let logStream = null;

function check(label, ok, detail) {
  if (ok) console.log(`  \u001b[32m✓\u001b[0m ${label}`);
  else {
    failures++;
    console.log(`  \u001b[31m✗\u001b[0m ${label}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`);
  }
}

const appLog = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '');

/* A configured profile, so the app under test starts ready to record. */
function seedProfile() {
  fs.writeFileSync(
    path.join(PROFILE, 'settings.json'),
    JSON.stringify({
      model: 'gemini-2.5-flash',
      uiLanguage: 'fa',
      copyToClipboard: true
    })
  );
}

function launch() {
  const electron = require('electron');
  const args = [
    '.',
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${PORT}`,
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream'
  ];
  logStream = fs.openSync(LOG, 'w');
  app = spawn(electron, args, {
    cwd: ROOT,
    env: Object.assign({}, process.env, { GUYA_DEBUG: '1', GUYA_SKIP_MIC_PREFLIGHT: '1' }),
    stdio: ['ignore', logStream, logStream]
  });
}

function listTargets() {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

async function waitForTargets(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const targets = await listTargets();
      const panel = targets.find((t) => t.url.includes('panel.html'));
      const overlay = targets.find((t) => t.url.includes('overlay.html'));
      if (panel && overlay) return { panel, overlay };
    } catch (_) {
      /* the port is not up yet */
    }
    await sleep(300);
  }
  throw new Error('the app did not expose its renderers in time');
}

class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message);
    });
  }
  ready() {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve);
      this.socket.addEventListener('error', reject);
    });
  }
  send(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const message = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (message.result.exceptionDetails) {
      throw new Error(message.result.exceptionDetails.exception.description || 'evaluation failed');
    }
    return message.result.result.value;
  }
}

(async () => {
  seedProfile();
  launch();
  const targets = await waitForTargets(30000);
  const panel = new Cdp(targets.panel.webSocketDebuggerUrl);
  const overlay = new Cdp(targets.overlay.webSocketDebuggerUrl);
  await panel.ready();
  await overlay.ready();
  await panel.send('Runtime.enable');
  await overlay.send('Runtime.enable');

  const el = (id) => panel.eval(`document.getElementById('${id}').textContent`);
  const phase = () => panel.eval('document.body.dataset.phase');
  /* Predicates may run while the page is still evaluating its scripts, so a throw
   * counts as "not yet" rather than as a failure. */
  const waitFor = async (fn, timeout, label) => {
    const until = Date.now() + timeout;
    let last = null;
    while (Date.now() < until) {
      try {
        last = await fn();
      } catch (_) {
        last = null;
      }
      if (last) return last;
      await sleep(200);
    }
    console.log('  (timed out waiting for ' + label + ')');
    return last;
  };
  const waveBars = () =>
    panel.eval(`(() => {
      const c = document.getElementById('waveform');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      const cols = [];
      for (let x = 0; x < c.width; x += Math.max(1, Math.round(c.width / 48))) {
        let top = -1, bottom = -1;
        for (let y = 0; y < c.height; y++) {
          if (d[(y * c.width + x) * 4 + 3] > 20) { if (top < 0) top = y; bottom = y; }
        }
        cols.push(top < 0 ? 0 : bottom - top);
      }
      return cols;
    })()`);

  await waitFor(async () => await panel.eval(`!!appState.phase && document.querySelector('.nav-title').textContent.length > 0`), 10000, 'the panel to boot');

  console.log('\n1. idle');
  check('two views, recorder first', (await panel.eval('document.body.dataset.view')) === 'recorder');
  check('the header names the app', APP_TITLES.indexOf(await panel.eval(`document.querySelector('.nav-title').textContent`)) !== -1,
    await panel.eval(`document.querySelector('.nav-title').textContent`));
  check('and so does the window', APP_TITLES.indexOf(await panel.eval('document.title')) !== -1,
    await panel.eval('document.title'));
  check('an unconfigured app says what is missing', /کلید/.test(await el('status')), await el('status'));
  check('timer starts at 0:00', (await el('timer')) === '0:00', await el('timer'));
  check('waveform sits at its baseline', Math.max.apply(null, await waveBars()) <= 8);
  check('no transcript actions yet', await panel.eval(`document.getElementById('copyTranscript').hidden`));

  /* The graph is built at boot, so a start has nothing to wait for but the device
   * itself. What must never happen at rest is a live microphone. The graph is built
   * asynchronously while the window loads, so this waits for it rather than
   * sampling at whatever moment the first check happens to run. */
  const rest = await waitFor(async () => {
    const state = await overlay.eval(`({
      graphReady: !!audioCtx && audioCtx.state === 'running' && !!captureNode,
      stream: stream === null,
      source: sourceNode === null
    })`);
    return state.graphReady || state.error ? state : null;
  }, 8000, 'the audio graph');
  check('the microphone is closed at rest', rest.stream && rest.source, JSON.stringify(rest));
  check('and the audio graph is already built, so a start is immediate', rest.graphReady);
  check('nothing of the floating orb is on screen', (await overlay.eval(`document.getElementById('stage').dataset.state`)) === 'idle');
  const gear = await panel.eval(`document.getElementById('openSettings').getBoundingClientRect().left`);
  check('the settings control sits clear of the window buttons', gear > 380, Math.round(gear));

  console.log('\n2. the key can be entered from the form');
  await panel.eval(`document.getElementById('openSettings').click()`);
  await sleep(250);
  await panel.eval(`(() => {
    const input = document.getElementById('apiKey');
    input.value = 'AIzaSyDUMMY-key-for-pipeline-test-000000';
    input.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  const stored = await waitFor(async () => await panel.eval(`guya.getAppInfo().then((i) => i.settings.apiKey.length > 0)`), 6000, 'the key to be stored');
  check('typing a key saves it without a Save button', stored === true, stored);
  await panel.eval(`document.getElementById('closeSettings').click()`);
  await sleep(300);
  check('the recorder now invites a tap', /ضبط/.test(await el('status')), await el('status'));
  await panel.eval(`document.getElementById('openSettings').click()`);
  await sleep(250);
  await panel.eval(`document.getElementById('closeSettings').click()`);
  await sleep(250);

  console.log('\n3. recording (window in front: this is the in-app case)');
  await panel.send('Page.bringToFront');
  await sleep(400);
  await panel.eval(`document.getElementById('record').click()`);

  /* While the device is opening, the orb must not look like it is listening. What is
   * checked is the drawing itself — the mean colour of the orb's canvas — because that
   * is what the user reads: the cool palette is the app's "working" colour and the warm
   * one means the microphone is really live. The state lasts as long as the device
   * takes to open, so both are sampled as they happen. */
  const orbTone = () => overlay.eval(`(() => {
    const canvas = document.getElementById('orb-canvas');
    const ctx = canvas.getContext('2d');
    const size = 16;
    const data = ctx.getImageData(Math.round(canvas.width / 2) - size / 2, Math.round(canvas.height / 2) - size / 2, size, size).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
    const n = data.length / 4;
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), state: document.getElementById('stage').dataset.state };
  })()`);

  const startingTone = await waitFor(async () => {
    const tone = await orbTone();
    return tone.state === 'starting' && tone.r + tone.g + tone.b > 40 ? tone : null;
  }, 3000, 'the orb to draw while the device opens').catch(() => null);
  if (startingTone) {
    check('while the device opens the orb is cool, not live', startingTone.b > startingTone.r, JSON.stringify(startingTone));
  } else {
    console.log('  (the device opened too fast to catch the starting state)');
  }

  const live = await waitFor(async () => {
    const p = await phase();
    return p === 'recording' ? p : null;
  }, 12000, 'the recording phase');
  check('the microphone goes live', live === 'recording', live);

  const liveTone = await waitFor(async () => {
    const tone = await orbTone();
    return tone.r > tone.b ? tone : null;
  }, 3000, 'the orb to turn warm').catch(() => null);
  check('and the orb turns warm when it really is live', !!liveTone, JSON.stringify(liveTone));

  await sleep(2200);
  check('status says it is listening', /شنیدن/.test(await el('status')), await el('status'));
  check('timer is counting', (await el('timer')) !== '0:00', await el('timer'));
  /* Ten seconds, not six: the first launch after an install is unpacking the app and
   * booting two renderers, and this check is "the meter is fed", not "within six". */
  const peak = await waitFor(async () => {
    const bars = await waveBars();
    return Math.max.apply(null, bars) > 20 ? Math.max.apply(null, bars) : 0;
  }, 10000, 'the meter');
  check('meter is fed by the microphone', peak > 20, peak);

  /* A meter made of one loudness number would light every bar by the same amount.
   * Chromium's fake device plays a steady tone, so a real spectrum has to put the
   * energy in the bands around that tone and leave the far ones alone. */
  const profile = await waitFor(async () => {
    const bars = await waveBars();
    const third = Math.floor(bars.length / 3);
    const low = Math.max.apply(null, bars.slice(0, third));
    const high = Math.max.apply(null, bars.slice(2 * third));
    return low > 20 ? { low, high } : null;
  }, 10000, 'a spectrum');
  check('the bars are frequency bands, not one loudness number', profile.low > profile.high * 2,
    JSON.stringify(profile));
  check('the button is stained while live', await panel.eval(`(() => {
    const s = getComputedStyle(document.getElementById('record'));
    const m = s.backgroundColor.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/);
    return !!m && Number(m[1]) > 200 && Number(m[2]) < 120;
  })()`));
  /* Chromium keeps reporting the page as visible for a window that was never
   * shown, so the app's own decision is the signal to assert on. */
  /* The panel has to actually be in front for this to be the in-app case, and the log
   * line to read is the one this recording produced — the last, not the first. */
  const focused = await waitFor(async () => (await panel.eval('document.hasFocus()')) === true, 3000, 'the panel to take focus').catch(() => false);
  check('the panel is in front, so this is the in-app case', focused === true);
  const decisions = Array.from((appLog() || '').matchAll(/\[guya\] overlay (\w+) \(window in front: (\w+)\)/g));
  const decision = decisions.length ? decisions[decisions.length - 1] : null;
  console.log('  overlay decision:', decision ? decision[0].replace('[guya] ', '') : 'not logged');
  check('the floating orb stays away while the window is in front', !!decision && decision[1] === 'suppressed', decision && decision[1]);
  check('Escape is grabbed while recording', /escape capture: on/.test(appLog()));

  console.log('\n4. stopping and transcribing');
  await panel.eval(`document.getElementById('record').click()`);
  /* Both read in the same round trip and at the first moment the phase is seen:
   * the transcription is short when the provider is unreachable, and a check that
   * samples the loader afterwards is a check that races it. */
  const working = await waitFor(async () => {
    const snapshot = await panel.eval(`({
      phase: appState.phase,
      loader: !document.getElementById('loader').hidden && loader.isRunning()
    })`);
    return snapshot.phase === 'transcribing' ? snapshot : null;
  }, 6000, 'the working phase');
  check('it moves to work immediately', working.phase === 'transcribing', working.phase);
  check('the orb becomes the loader', working.loader === true, JSON.stringify(working));
  const settled = await waitFor(async () => {
    const p = await phase();
    return ['done', 'error'].indexOf(p) !== -1 ? p : null;
  }, 30000, 'a result');
  check('a terminal state is reached', settled === 'done' || settled === 'error', settled);
  check('the status carries the provider answer', (await el('status')).length > 0, await el('status'));
  check('the loader goes away', await waitFor(async () => (await panel.eval(`document.getElementById('loader').hidden`)) === true, 3000, 'the loader to stop'));
  check('Escape grab released', /escape capture: off/.test(appLog()));

  /* Once the overlay is hidden it must stop drawing. The renderer is deliberately not
   * throttled — it owns the microphone — so nothing would stop its frame loop except
   * being told to, and an app that keeps drawing a hidden orb burns a core for as long
   * as it is open. A canvas that does not change between two samples is a canvas
   * nothing is drawing. */
  await waitFor(async () => (await overlay.eval(`document.getElementById('stage').dataset.state`)) === 'idle', 6000, 'the overlay to go idle');
  /* The state is set before the loop is cancelled, so the first sample waits a moment
   * for the last frame to land. */
  await sleep(400);
  const frozen = await overlay.eval(`(() => {
    const canvas = document.getElementById('orb-canvas');
    const ctx = canvas.getContext('2d');
    const grab = () => Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data).join('');
    window.__first = grab();
    return window.__first.length;
  })()`);
  await sleep(1200);
  const stillFrozen = await overlay.eval(`(() => {
    const canvas = document.getElementById('orb-canvas');
    const ctx = canvas.getContext('2d');
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data).join('') === window.__first;
  })()`);
  check('and a hidden overlay stops drawing', stillFrozen === true, JSON.stringify({ sampled: frozen }));

  console.log('\n5. the transcript view');
  await panel.eval(`onState(Object.assign({}, appState, {phase:'done', lastTranscript:'یک یادداشت کوتاه برای آزمون.', lastDurationMs:10000}))`);
  await sleep(250);
  check('the transcript is plain text', (await panel.eval(`document.getElementById('transcript').textContent`)).length > 0);

  /* A transcript carries its own direction: the interface language must not
   * decide how a sentence is read. */
  const cases = [
    { text: 'این یادداشت فارسی است و راست‌به‌چپ خوانده می‌شود.', language: 'en', expected: 'rtl' },
    { text: 'This note is English and reads left to right.', language: 'en', expected: 'ltr' },
    { text: 'OK حالا برویم سراغ جلسه فردا', language: 'en', expected: 'rtl' },
    { text: 'یک خط اول\n\nو یک خط دوم انگلیسی: done', language: 'en', expected: 'rtl' }
  ];
  for (const item of cases) {
    await panel.eval(`onState(Object.assign({}, appState, { phase: 'done', lastTranscript: ${JSON.stringify(item.text)} }))`);
    await sleep(150);
    const paragraphs = await panel.eval(`Array.from(document.querySelectorAll('#transcript p')).map((p) => p.getAttribute('dir'))`);
    check('direction of "' + item.text.slice(0, 22) + '…"', paragraphs[0] === item.expected, { got: paragraphs, expected: item.expected, uiLanguage: await panel.eval('document.documentElement.dir') });
  }
  check('the console moves up when there is text', (await panel.eval('document.body.dataset.transcript')) === 'true');
  check('the timer keeps the finished duration', (await el('timer')) === '0:10', await el('timer'));
  check('copy becomes available', !(await panel.eval(`document.getElementById('copyTranscript').hidden`)));

  console.log('\n6. settings');
  await panel.eval(`document.getElementById('openSettings').click()`);
  await sleep(400);
  check('settings is the pushed view', (await panel.eval('document.body.dataset.view')) === 'settings');
  /* The back control was 76px into the window when the toolbar reserved a column
   * for the window buttons. It belongs on the leading edge, and the window buttons
   * — which appear over the top-left corner on hover — get a band above the row. */
  const back = await panel.eval(`(() => {
    const b = document.getElementById('closeSettings').getBoundingClientRect();
    const nav = document.querySelector('#view-settings .navbar').getBoundingClientRect();
    return { left: b.left, top: b.top, right: b.right, navLeft: nav.left, navRight: nav.right, navTop: nav.top,
             mac: document.body.classList.contains('is-mac'), dir: document.documentElement.dir };
  })()`);
  /* In Persian the leading edge is the right one; the control follows the language. */
  const leading = back.dir === 'rtl' ? back.navRight - back.right : back.left - back.navLeft;
  check('the back control sits on the leading edge', leading < 24, JSON.stringify(back));
  check('and below the band the window buttons use', !back.mac || back.top - back.navTop >= 30, JSON.stringify(back));

  /* The window buttons appear when the pointer reaches the top of the window, so
   * the top of the window has to hold nothing: a control up there summons them and
   * the click goes to them. The strip is the only drag region, which is also what
   * keeps the window draggable by its top edge. */
  const chrome = await panel.eval(`(() => {
    const strip = document.querySelector('.titlebar-drag');
    const box = strip ? strip.getBoundingClientRect() : null;
    const nav = document.querySelector('#view-settings .navbar');
    const height = box ? box.height : 0;
    const controls = Array.from(document.querySelectorAll('#view-settings button, #view-settings input, #view-settings select, #view-settings textarea, #view-settings [role="button"]'));
    /* Only the ones on screen: a hidden control reports a rectangle at the origin,
     * which would read as "in the strip" without being anywhere near it. */
    const visible = controls.filter((c) => c.offsetParent !== null || c.getClientRects().length > 0);
    return {
      strip: Math.round(height),
      controlsInStrip: visible.filter((c) => c.getBoundingClientRect().top < height).length,
      dragRegion: getComputedStyle(nav).webkitAppRegion
    };
  })()`);
  check('the window buttons get an empty strip of their own', chrome.strip >= 28, JSON.stringify(chrome));
  check('nothing interactive sits in it', chrome.controlsInStrip === 0, JSON.stringify(chrome));
  check('and the header is not a drag region that would summon them', chrome.dragRegion === 'none', chrome.dragRegion);
  check('the model picker is populated', (await panel.eval(`document.getElementById('modelSelect').options.length`)) > 1);
  check('the spoken-language picker is populated', (await panel.eval(`document.getElementById('language').options.length`)) > 5);
  check('the silence stop offers real choices', (await panel.eval(`document.getElementById('silenceStop').options.length`)) >= 4);
  check('stopping when nobody speaks is a setting of its own', (await panel.eval(`document.getElementById('noSpeechStop').options.length`)) >= 4);

  /* The list is what is offered, not what is allowed: someone who wants 4.5
   * seconds types it and it survives. */
  await panel.eval(`(() => {
    const select = document.getElementById('silenceStop');
    select.value = '__custom__';
    select.dispatchEvent(new Event('change'));
    const field = document.getElementById('silenceCustom');
    field.value = '4.5';
    field.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  await sleep(700);
  const custom = await panel.eval('guya.getAppInfo().then((i) => i.settings.silenceStopMs)');
  check('a duration the list does not offer still sticks', custom === 4500, String(custom));
  await panel.eval(`(() => {
    const select = document.getElementById('silenceStop');
    select.value = '3000';
    select.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(500);
  check('the attempt count is offered', (await panel.eval(`document.getElementById('attempts').options.length`)) >= 3);
  check('durations are locale-formatted', /[۰-۹]/.test(await panel.eval(`document.getElementById('silenceStop').options[1].textContent`)));
  check('the key is present', (await panel.eval(`document.getElementById('apiKey').value.length`)) > 0);

  /* The field holds the instructions the model is given, so the user can read and
   * change them. It is English in a Persian window too, and laid out left-to-right
   * whatever the window's direction is. */
  const promptField = await panel.eval(`(() => {
    const field = document.getElementById('prompt');
    return { value: field.value, dir: field.getAttribute('dir'), computed: getComputedStyle(field).direction,
             reset: !!document.getElementById('resetPrompt') };
  })()`);
  check('the prompt field is filled with the instructions', promptField.value === GuyaPrompt.DEFAULT_PROMPT,
    promptField.value.slice(0, 60));
  check('and stays English', !/[\u0600-\u06FF]/.test(promptField.value));
  check('the field is left-to-right in a right-to-left window', promptField.dir === 'ltr' && promptField.computed === 'ltr',
    JSON.stringify({ dir: promptField.dir, computed: promptField.computed }));
  check('the default prompt can be restored', promptField.reset);
  await panel.eval(`(() => {
    const field = document.getElementById('prompt');
    field.value = 'Say only what is said.';
    field.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  await sleep(600);
  const edited = await panel.eval(`guya.getAppInfo().then((i) => i.settings.prompt)`);
  check('an edit is saved without a button', edited === 'Say only what is said.', edited);
  await panel.eval(`document.getElementById('resetPrompt').click()`);
  await sleep(600);
  const restored = await panel.eval(`guya.getAppInfo().then((i) => i.settings.prompt)`);
  check('and the default prompt can be put back', restored === GuyaPrompt.DEFAULT_PROMPT, restored.slice(0, 40));
  await panel.eval(`(() => {
    const field = document.getElementById('prompt');
    field.value = GuyaPrompt.DEFAULT_PROMPT;
    field.dispatchEvent(new Event('blur'));
    return true;
  })()`);
  await sleep(600);

  check('the shortcut is drawn as key caps', (await panel.eval(`document.querySelectorAll('#shortcut kbd').length`)) >= 2);
  check('every group has a title and most have a footnote', (await panel.eval(`document.querySelectorAll('.section-title').length`)) >= 4 && (await panel.eval(`document.querySelectorAll('.footnote').length`)) >= 3);
  check('no wake-word setting exists any more', (await panel.eval(`document.querySelectorAll('#wakeEnabled,#wakeWord').length`)) === 0);

  /* Closing the window hides it — the shortcut has to outlive the window — so the app needs
   * a control that really quits it. Where there is no menu bar that control is the only way
   * out, and a missing element or a raw i18n key is a user who cannot close the app. */
  const quit = await panel.eval(`(() => {
    const row = document.getElementById('quitFootnote');
    const button = document.getElementById('quitApp');
    return row && button ? { hidden: row.hidden, label: button.textContent.trim(), mac: guya.platform === 'darwin' } : null;
  })()`);
  check('the quit control exists and has a label', !!quit && quit.label.length > 0 && !/^ui\./.test(quit.label), JSON.stringify(quit));
  check('and it stays out of the way where the menu already quits', !!quit && quit.hidden === quit.mac, JSON.stringify(quit));

  /* Automatic paste needs a system permission. Without it the switch must refuse
   * to stay on, and the form must say so and offer the pane. */
  const permission = await panel.eval('guya.accessibilityStatus()');
  await panel.eval(`(() => { const s = document.getElementById('pasteAfterTranscribe'); s.checked = true; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(2000);
  const paste = await panel.eval(`({
    toggle: document.getElementById('pasteAfterTranscribe').checked,
    notice: !document.getElementById('pasteNotice').hidden,
    offersPane: !!document.getElementById('openAccessibility')
  })`);
  /* Read the permission again rather than trusting the earlier reading: the switch
   * asks macOS for it, and the answer can change while this is running — which is
   * exactly when the old reading turned this into a flake. What is being asserted
   * is that the switch agrees with the current answer, not with an old one. */
  const afterAttempt = await panel.eval('guya.accessibilityStatus()');
  console.log('  accessibility granted:', afterAttempt.granted, '| paste toggle:', paste.toggle, '| notice:', paste.notice);
  check('the setting follows the permission', afterAttempt.granted ? paste.toggle === true : paste.toggle === false, paste);
  if (!afterAttempt.granted) check('the refusal offers the system pane', paste.notice && paste.offersPane, paste);
  /* The interface language is a real switch, not a translation layer: in English
   * nothing Persian may survive anywhere on screen, tooltips and names included. */
  await panel.eval(`(() => { const s = document.getElementById('uiLanguageSelect'); s.value = 'en'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(1200);
  const english = await panel.eval(`(() => {
    const text = document.getElementById('view-settings').innerText + ' ' + document.getElementById('view-recorder').innerText;
    const labels = Array.from(document.querySelectorAll('#view-settings [aria-label], #view-recorder [aria-label]')).map((n) => n.getAttribute('aria-label')).join(' ');
    const placeholders = Array.from(document.querySelectorAll('[placeholder]')).map((n) => n.placeholder).join(' ');
    return { text: text + ' ' + labels + ' ' + placeholders, settingsTitle: document.querySelector('#view-settings .nav-title').textContent };
  })()`);
  check('the settings screen speaks English', /Settings/.test(english.settingsTitle), english.settingsTitle);
  check('nothing Persian is left on screen in English', !/[\u0600-\u06FF]/.test(english.text), english.text.match(/[\u0600-\u06FF]{1,12}/g));
  await panel.eval(`(() => { const s = document.getElementById('uiLanguageSelect'); s.value = 'fa'; s.dispatchEvent(new Event('change')); return true; })()`);
  await sleep(1000);
  check('and back to Persian', /تنظیمات/.test(await panel.eval(`document.querySelector('#view-settings .nav-title').textContent`)));

  await panel.eval(`document.getElementById('closeSettings').click()`);
  await sleep(300);
  check('back returns to the recorder', (await panel.eval('document.body.dataset.view')) === 'recorder');

  console.log('\n7. hygiene');
  check('no renderer errors', !/renderer:.*ERROR/.test(appLog()));
  check('no unhandled rejections', !/UnhandledPromiseRejection/.test(appLog()));

  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
})()
  .catch((err) => {
    console.error('e2e error:', err.message);
    failures++;
  })
  .finally(() => {
    /* The app is killed here and only here. Exiting from the middle of the chain used to
     * skip this, and an Electron instance that outlives the run keeps the single-instance
     * lock — so the next `npm start` quits itself and the machine is left with a hidden
     * app. */
    if (app) app.kill();
    process.exitCode = failures ? 1 : 0;
    if (logStream) {
      try {
        fs.closeSync(logStream);
      } catch (_) {
        /* already closed */
      }
    }
  });
