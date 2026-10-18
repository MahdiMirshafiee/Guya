/*
 * Guya — the shell and the recorder.
 *
 * One screen with exactly one focal point: a drawn meter, a timer, one line of
 * state, the transcript, and a single glass control. Everything else lives on the
 * settings screen this file pushes over.
 */
'use strict';

const api = window.guya;
let settings = {};
let appState = { phase: 'idle', lastTranscript: '' };
const t = (key, vars) => GuyaI18n.t(settings.uiLanguage, key, vars);

const R = {
  viewRecorder: document.getElementById('view-recorder'),
  viewSettings: document.getElementById('view-settings'),
  waveform: document.getElementById('waveform'),
  loader: document.getElementById('loader'),
  timer: document.getElementById('timer'),
  status: document.getElementById('status'),
  transcript: document.getElementById('transcript'),
  copyTranscript: document.getElementById('copyTranscript'),
  openSettings: document.getElementById('openSettings'),
  closeSettings: document.getElementById('closeSettings'),
  record: document.getElementById('record'),
  version: document.getElementById('version'),
  settingsStatus: document.getElementById('settingsStatus')
};

/* ------------------------------------------------------------ waveform --- */

/* The meter is a spectrum: 48 capsule bars, each one a frequency band of the live
 * input, fed at 20 Hz from the overlay, which is where the microphone lives. A
 * band rises quickly and falls slowly, the way a level meter does, so speech reads
 * as movement instead of flicker. At rest the bars sit at a visible baseline
 * rather than collapsing to a hairline. */
const WAVE_BARS = 48; // one per spectrum band, as the overlay sends them
const WAVE_SPACING = 3;
const WAVE_MIN_HEIGHT = 4;
/* The data arrives at about 30 Hz already smoothed by the overlay's meters, so the
 * panel only has to take the edge off. WAVE_BARS is the overlay's own band count:
 * one bar per band, in band order. */
const WAVE_ATTACK = 0.7;
const WAVE_RELEASE = 0.25;
let bands = new Array(WAVE_BARS).fill(0);
let bars = new Array(WAVE_BARS).fill(0);
let waveDpr = 1;
let waveRaf = 0;

function sizeWaveform() {
  waveDpr = Math.min(2, window.devicePixelRatio || 1);
  const width = R.waveform.clientWidth || 432;
  const height = R.waveform.clientHeight || 56;
  R.waveform.width = Math.round(width * waveDpr);
  R.waveform.height = Math.round(height * waveDpr);
  drawWaveform();
}

/* One animation frame per arrival, not one per band: the bars are drawn together
 * from the values the microphone just produced. */
function animateWaveform() {
  if (waveRaf) return;
  waveRaf = requestAnimationFrame(() => {
    waveRaf = 0;
    let moving = false;
    for (let i = 0; i < WAVE_BARS; i++) {
      const target = bands[i] || 0;
      const previous = bars[i];
      bars[i] = target > previous ? previous + (target - previous) * WAVE_ATTACK : previous + (target - previous) * WAVE_RELEASE;
      if (Math.abs(bars[i] - target) > 0.002) moving = true;
    }
    drawWaveform();
    if (moving) animateWaveform();
  });
}

/* Read once per phase change rather than once per frame: getComputedStyle forces a
 * style recalculation, and this is drawn thirty times a second. */
let waveTint = '#000';

function readWaveTint() {
  const css = getComputedStyle(document.body);
  const active = appState.phase === 'recording' || appState.phase === 'starting';
  waveTint = (active ? css.getPropertyValue('--text') : css.getPropertyValue('--text-3')).trim() || '#000';
}

function drawWaveform() {
  const ctx = R.waveform.getContext('2d');
  if (!ctx) return;
  const cssWidth = R.waveform.width / waveDpr;
  const cssHeight = R.waveform.height / waveDpr;
  const tint = waveTint;

  ctx.setTransform(waveDpr, 0, 0, waveDpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const barWidth = Math.max(1.5, (cssWidth - WAVE_SPACING * (WAVE_BARS - 1)) / WAVE_BARS);
  const radius = barWidth / 2;
  ctx.fillStyle = tint;

  for (let i = 0; i < WAVE_BARS; i++) {
    const height = Math.max(WAVE_MIN_HEIGHT, bars[i] * cssHeight);
    const x = i * (barWidth + WAVE_SPACING);
    const y = (cssHeight - height) / 2;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, barWidth, height, radius);
    else ctx.rect(x, y, barWidth, height);
    ctx.fill();
  }
}

/* The bands arrive as one array in band order, so a bar can never be fed by the
 * wrong band: it is drawn from the value the microphone produced for it. */
function pushSpectrum(levels) {
  if (!Array.isArray(levels) || !levels.length) return;
  for (let i = 0; i < WAVE_BARS; i++) {
    if (i < levels.length) bands[i] = levels[i];
  }
  animateWaveform();
}

/* -------------------------------------------------------------- loader --- */

/* While the transcript is being fetched the microphone is closed, so the meter
 * has nothing to say. The orb takes its place: the same object that floats above
 * the desktop, with its cool "working" palette. It is the app's own mark doing
 * the waiting, not a generic spinner. */
const loader = GuyaOrb.create(R.loader, { box: 96, sphere: 27, palette: 'busy' });
loader.setDriven(false);
loader.setProcessing(true);

function renderLoader() {
  const working = appState.phase === 'transcribing';
  if (working === !R.loader.hidden) return;
  R.loader.hidden = !working;
  if (working) {
    loader.resize();
    loader.start();
  } else {
    loader.stop();
  }
}

/* --------------------------------------------------------------- timer --- */

/* Built from whole seconds by hand: mm:ss is not a localised string, and a
 * format style on a label redrawn every second is work for nothing. */
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

function elapsedMs() {
  if (appState.phase === 'recording') return Date.now() - (appState.startedAt || Date.now());
  if (appState.phase === 'transcribing') return Math.max(appState.lastDurationMs || 0, 0);
  if (appState.phase === 'done') return appState.lastDurationMs || 0;
  return 0;
}

function renderTimer() {
  R.timer.textContent = formatClock(elapsedMs());
}

/* --------------------------------------------------------------- state --- */

/* Only what is true right now. Nothing here is a welcome message. */
function statusCopy() {
  if (appState.phase === 'error') {
    return { text: appState.lastErrorKey ? t(appState.lastErrorKey, appState.lastErrorVars) : t('error.unexpected'), kind: 'error' };
  }
  /* The transcript is safe — it is in the clipboard — but the keystroke that was meant
   * to type it into the app the user is in did not happen, and the window is where they
   * look for the reason. */
  if (appState.phase === 'done' && appState.lastErrorKey) {
    return { text: t(appState.lastErrorKey, appState.lastErrorVars), kind: 'error' };
  }
  if (appState.phase === 'starting') return { text: t('status.starting'), kind: '' };
  if (appState.phase === 'recording') return { text: t('status.listening'), kind: '' };
  if (appState.phase === 'transcribing') {
    // A retry is the most useful thing to say while waiting: it explains the wait
    // instead of restating it.
    return {
      text: appState.retryNote
        ? t('status.retrying', { attempt: appState.retryNote.attempt, total: appState.retryNote.total })
        : t('status.transcribing'),
      kind: ''
    };
  }
  if (!settings.apiKey) return { text: t('error.noKey'), kind: '' };
  /* Saying this here matters more than anywhere else: the shortcut is how the app is used,
   * and a combination the system is not holding fails silently — the user presses it, and
   * nothing happens, on the screen that exists to say what is true right now. */
  if (settings.shortcut && appState.shortcutHeld === false) {
    return { text: t(appState.shortcutErrorKey || 'ui.shortcutNotHeld'), kind: 'warn' };
  }
  if (!appState.lastTranscript) return { text: t('ui.tapToRecord'), kind: '' };
  return null;
}

/* The transcript is content, and content carries its own direction: one block
 * per paragraph, each laid out the way its own language is read. The browser's
 * bidi algorithm then places any foreign word inside that paragraph correctly. */
let renderedTranscript = null;

function renderTranscript(text) {
  /* A state push arrives for the timer, the level, the retry note — and every one of
   * them used to rebuild these paragraphs, which throws away the user's selection
   * while they are reading. Nothing to do is nothing to do. */
  if (text === renderedTranscript) return;
  renderedTranscript = text;

  R.transcript.textContent = '';
  GuyaBidi.blocksOf(text).forEach((line) => {
    const paragraph = document.createElement('p');
    paragraph.setAttribute('dir', GuyaBidi.directionOf(line, document.documentElement.dir));
    paragraph.textContent = line;
    R.transcript.appendChild(paragraph);
  });
}

function renderRecorder() {
  const phase = appState.phase || 'idle';
  readWaveTint();
  document.body.dataset.phase = phase;
  const text = appState.lastTranscript || '';
  document.body.dataset.transcript = text ? 'true' : 'false';

  renderTranscript(text);
  R.transcript.hidden = !text;
  R.copyTranscript.hidden = !text;

  const status = statusCopy();
  R.status.textContent = status ? status.text : '';
  R.status.className =
    'status-line' +
    (status && status.text ? ' is-shown' : '') +
    (status && status.kind === 'error' ? ' is-error' : '') +
    (status && status.kind === 'warn' ? ' is-warn' : '');

  const recording = phase === 'recording';
  /* While the answer is being fetched the same control cancels it: the wait is the
   * longest part of a recording, and until now there was no way out of it. */
  const label = phase === 'transcribing' ? t('action.cancel') : recording ? t('action.stop') : t('action.record');
  R.record.setAttribute('aria-label', label);
  R.record.setAttribute('aria-disabled', phase === 'starting' ? 'true' : 'false');

  renderTimer();
  renderLoader();
}

/* Re-render everything that depends on the language. */
function applyI18n() {
  const language = settings.uiLanguage === 'en' ? 'en' : 'fa';
  document.documentElement.lang = language;
  document.documentElement.dir = language === 'fa' ? 'rtl' : 'ltr';
  document.title = t('ui.title');

  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => {
    node.placeholder = t(node.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nLabel));
  });

  R.openSettings.setAttribute('aria-label', t('ui.settings'));
  R.closeSettings.setAttribute('aria-label', t('ui.back'));
  R.copyTranscript.setAttribute('aria-label', t('ui.copyTranscript'));

  renderedTranscript = null; // the direction of each paragraph follows the language
  renderRecorder();
  if (window.__repaintSettings) window.__repaintSettings();
}

/* ---------------------------------------------------------------- shell --- */

function goTo(view) {
  const settingsView = view === 'settings';
  if (settingsView && window.__refreshSettings) window.__refreshSettings();
  document.body.dataset.view = settingsView ? 'settings' : 'recorder';
  R.viewSettings.setAttribute('aria-hidden', String(!settingsView));
  R.viewRecorder.setAttribute('aria-hidden', String(settingsView));
  if (settingsView) {
    R.viewSettings.removeAttribute('inert');
    R.viewRecorder.setAttribute('inert', '');
  } else {
    R.viewRecorder.removeAttribute('inert');
    R.viewSettings.setAttribute('inert', '');
  }
}

function goBack() {
  goTo('recorder');
}

async function onRecord() {
  if (appState.phase === 'transcribing') {
    await api.cancelRecording();
    return;
  }
  if (appState.phase === 'starting') return;
  // An unconfigured app cannot record anything, so take the user where the fix
  // is instead of failing after they have spoken.
  if (!settings.apiKey) {
    goTo('settings');
    return;
  }
  await api.toggleRecording();
}

async function copyTranscript() {
  const text = appState.lastTranscript || R.transcript.textContent;
  if (!text) return;
  await api.copyToClipboard(text);
  R.copyTranscript.classList.add('is-done');
  setTimeout(() => R.copyTranscript.classList.remove('is-done'), 1500);
}

/* One writer for both views: every control writes through as it changes. */
async function saveSettings(patch) {
  const response = await api.saveSettings(patch || currentFormPatch());
  settings = response.settings;
  applyAccent();
  applyI18n();
  return response;
}

function applyAccent() {
  if (appState.accent) document.documentElement.style.setProperty('--accent', appState.accent);
}

function onState(state) {
  if (!state) return;
  appState = state;
  applyAccent();
  renderRecorder();
  if (window.__renderFormStatus) window.__renderFormStatus();
  if (window.__renderShortcutNotice) window.__renderShortcutNotice();
}

/* ------------------------------------------------------------------ wire --- */

R.openSettings.addEventListener('click', () => goTo('settings'));
R.closeSettings.addEventListener('click', goBack);
R.record.addEventListener('click', onRecord);
R.copyTranscript.addEventListener('click', copyTranscript);

/* Two conventional ways back out of a pushed screen: Escape, and the macOS
 * Command-[ . Neither should fire while the microphone is live, because Escape
 * stops a recording then. */
document.addEventListener('keydown', (event) => {
  if (document.body.dataset.view !== 'settings') return;
  if (appState.phase === 'recording' || appState.phase === 'starting') return;
  const escape = event.key === 'Escape';
  const back = (event.metaKey || event.ctrlKey) && event.key === '[';
  if (!escape && !back) return;
  event.preventDefault();
  goBack();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  readWaveTint();
  drawWaveform();
});

window.addEventListener('resize', () => {
  sizeWaveform();
  loader.resize();
});
api.onSpectrum((levels) => {
  if (appState.phase !== 'recording' && appState.phase !== 'starting') return;
  pushSpectrum(levels);
});
api.onPanelState(onState);

/* While nothing is being recorded the meter settles back to its baseline. */
setInterval(() => {
  if (appState.phase === 'recording' || appState.phase === 'starting') return;
  let moving = false;
  for (const level of bars) if (level > 0.001) moving = true;
  if (!moving) return;
  for (let i = 0; i < WAVE_BARS; i++) {
    bands[i] = 0;
    bars[i] *= 0.72;
  }
  drawWaveform();
}, 100);

/* The timer only ever counts whole seconds. */
setInterval(() => {
  if (appState.phase === 'recording') renderTimer();
}, 250);

(async function boot() {
  GuyaAccelerator.setPlatform(api.platform);
  const info = await api.getAppInfo();
  settings = info.settings;
  appState = info.state;
  R.version.textContent = appState.version || info.version;
  if (info.platform === 'darwin') document.body.classList.add('is-mac');
  /* The settings are here, and both scripts have to be able to say so: this one calls the
   * settings script's paint below, and that script — which may not have run yet — paints
   * on its own load when this flag is up. Whoever is last paints; without the flag, a
   * fast answer from the main process won the race, the paint above found no hook to
   * call, and the form stayed empty until something happened to save. */
  window.__shellReady = true;
  applyAccent();
  sizeWaveform();
  applyI18n();
})();
