/*
 * Overlay renderer.
 *
 * Owns the microphone while a recording is in progress and draws the orb: a
 * glass sphere with four soft colour clouds drifting inside it. Each cloud is
 * driven by one frequency band of the live input, so the orb doubles as the
 * level meter.
 *
 * Capture lives here (and not in a hidden window) because this window is visible
 * exactly while recording, which keeps Chromium's audio pipeline unpaused.
 */
'use strict';

const api = window.guya;
const stage = document.getElementById('stage');
const messageEl = document.getElementById('message');
const canvas = document.getElementById('orb-canvas');

const BOX = 96; // canvas box in CSS pixels
const ORB_R = 27; // sphere radius
const DEFAULT_SILENCE_STOP_MS = 10000;

/* Frequency bands (Hz) mapped onto the four clouds. */
const BANDS = [
  [90, 260],
  [260, 800],
  [800, 2400],
  [2400, 7200]
];

const PALETTE_FOR = { starting: 'live', listening: 'live', processing: 'busy', done: 'done', error: 'failed' };

let stream = null;
let audioCtx = null;
let sourceNode = null;
let captureNode = null;
let sinkNode = null;
let analyser = null;
let spectrum = null;
let chunks = [];
let captureRate = 0;
let capturing = false;
let pendingStop = false;
let bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
let levelTickAt = 0;
let silenceStopMs = DEFAULT_SILENCE_STOP_MS;
let lastVoiceAt = 0;

/* Rolling noise floor, so the silence detector adapts to the room instead of
 * relying on one hard-coded level. */
const noiseFloor = {
  value: 0.004,
  update(rms) {
    if (rms < this.value) this.value = rms;
    else this.value += (rms - this.value) * 0.0008;
  },
  gate() {
    return Math.max(0.01, this.value * 3);
  }
};

const orb = GuyaOrb.create(canvas, {
  box: BOX,
  sphere: ORB_R,
  palette: 'live',
  onFrame: () => {
    if (stage.dataset.state === 'listening') readSpectrum();
    orb.setLevels(bands);
  }
});

/* ------------------------------------------------------------ level loop -- */

function readSpectrum() {
  if (!analyser || !spectrum) return;
  analyser.getByteFrequencyData(spectrum);
  const perBin = (captureRate || 48000) / 2 / spectrum.length;

  for (let i = 0; i < BANDS.length; i++) {
    const from = Math.max(0, Math.floor(BANDS[i][0] / perBin));
    const to = Math.min(spectrum.length - 1, Math.ceil(BANDS[i][1] / perBin));
    let sum = 0;
    let count = 0;
    for (let bin = from; bin <= to; bin++) {
      sum += spectrum[bin];
      count++;
    }
    const average = count ? sum / count / 255 : 0;
    const target = Math.min(1, Math.max(GuyaOrb.REST, Math.pow(average, 0.62) * 1.25));
    const previous = bands[i];
    bands[i] = target > previous ? previous + (target - previous) * 0.55 : previous + (target - previous) * 0.14;
  }
}

function setState(name, text) {
  stage.dataset.state = name;
  messageEl.textContent = text || '';
  messageEl.classList.toggle('show', !!text);

  if (name === 'idle') {
    orb.stop();
    return;
  }
  orb.setDriven(name === 'listening' || name === 'starting');
  orb.setProcessing(name === 'processing');
  orb.setPalette(PALETTE_FOR[name] || 'live');
  orb.start();
}

/* ------------------------------------------------------------- capture ----- */

async function createCaptureNode(context) {
  const onChunk = (chunk) => {
    const rms = GuyaAudio.rms(chunk);
    noiseFloor.update(rms);

    /* One level value per 50 ms to the panel, so its meter is fed by the same
     * measurement the orb uses. */
    if (capturing) {
      const at = performance.now();
      if (at - levelTickAt > 50) {
        levelTickAt = at;
        const shaped = Math.min(1, Math.pow(rms * 8, 0.6));
        api.sendLevel(shaped);
      }
    }

    if (!capturing) return;
    chunks.push(chunk);
    if (rms > noiseFloor.gate()) lastVoiceAt = performance.now();
    else if (silenceStopMs > 0 && performance.now() - lastVoiceAt > silenceStopMs) {
      // Tell the main process first, so it is ready to transcribe the result.
      api.overlayAutoStopped();
      stopCapture();
    }
  };

  if (context.audioWorklet) {
    try {
      await context.audioWorklet.addModule('/renderer/overlay/capture-worklet.js');
      const worklet = new AudioWorkletNode(context, 'guya-capture');
      worklet.port.onmessage = (event) => onChunk(event.data);
      return worklet;
    } catch (err) {
      console.warn('[guya] AudioWorklet unavailable, falling back to ScriptProcessor:', err && err.message);
    }
  }

  const processor = context.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (event) => onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
  return processor;
}

function micErrorKey(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'error.micDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'error.micNotFound';
  if (name === 'NotReadableError') return 'error.micBusy';
  return 'error.micFailed';
}

function teardown() {
  try {
    if (sourceNode) sourceNode.disconnect();
    if (analyser) analyser.disconnect();
    if (captureNode) {
      if (captureNode.port) captureNode.port.onmessage = null;
      if (captureNode.onaudioprocess !== undefined) captureNode.onaudioprocess = null;
      captureNode.disconnect();
    }
    if (sinkNode) sinkNode.disconnect();
  } catch (_) {
    /* nodes may already be gone */
  }
  if (stream) stream.getTracks().forEach((track) => track.stop());
  if (audioCtx) audioCtx.close().catch(() => {});
  stream = null;
  audioCtx = null;
  sourceNode = null;
  captureNode = null;
  sinkNode = null;
  analyser = null;
  spectrum = null;
}

async function reportFailure(err) {
  capturing = false;
  pendingStop = false;
  teardown();
  bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
  setState('error', '');
  // The main process localizes the message and sends it back as a flash.
  await api.overlayFailed(err && err.name ? micErrorKey(err) : typeof err === 'string' ? err : 'error.micFailed');
}

/* Opens the microphone and builds the capture graph. Returns false on failure
 * (after reporting it), so callers can bail out. */
async function openMic() {
  try {
    // echoCancellation off: nothing is being played back, and the filter can
    // chew on quiet speech. Everything else stays at the platform default.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, channelCount: 1 } });
  } catch (err) {
    reportFailure(err);
    return false;
  }

  try {
    audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    captureNode = await createCaptureNode(audioCtx);
    // A muted sink keeps the graph pulling without making any sound.
    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;
    sourceNode.connect(captureNode);
    captureNode.connect(sinkNode);
    sinkNode.connect(audioCtx.destination);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.65;
    spectrum = new Uint8Array(analyser.frequencyBinCount);
    sourceNode.connect(analyser);
    analyser.connect(sinkNode);

    captureRate = audioCtx.sampleRate;
  } catch (err) {
    reportFailure(err);
    return false;
  }
  return true;
}

async function startCapture() {
  if (capturing) return;
  pendingStop = false;
  bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
  chunks = [];
  lastVoiceAt = performance.now();
  setState('starting', '');

  captureRate = 0;
  const opened = await openMic();
  if (!opened) return;

  capturing = true;
  setState('listening', '');
  api.overlayReady();

  if (pendingStop) stopCapture();
}

async function stopCapture() {
  if (!capturing) {
    // The shortcut fired while the microphone was still starting up.
    pendingStop = true;
    return;
  }
  capturing = false;
  pendingStop = false;
  setState('processing', '');

  const rate = captureRate || 48000;
  const samples = GuyaAudio.concatFloat32(chunks);
  const durationMs = Math.round((samples.length / rate) * 1000);
  chunks = [];
  teardown();

  let wav;
  try {
    wav = GuyaAudio.wavFromFloat32(samples, rate);
  } catch (err) {
    return reportFailure('error.micFailed');
  }

  api.overlayResult(wav, durationMs);
}

/* -------------------------------------------------------------- commands --- */

api.onOverlayCommand((payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'start') {
    if (Number.isFinite(payload.silenceStopMs)) silenceStopMs = payload.silenceStopMs;
    startCapture();
  } else if (payload.type === 'stop') {
    stopCapture();
  } else if (payload.type === 'flash') {
    // The main process sends a key; this window owns the words, in whatever
    // language the interface is in right now.
    const text = payload.messageKey ? GuyaI18n.t(payload.language, payload.messageKey, payload.messageVars) : '';
    setState(payload.state === 'error' ? 'error' : 'done', text);
  }
});

/* ------------------------------------------------------------------ boot --- */

window.addEventListener('resize', () => orb.resize());
