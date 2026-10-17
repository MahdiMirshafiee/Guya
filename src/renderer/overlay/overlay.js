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
const DEFAULT_SILENCE_STOP_MS = 3000;
const DEFAULT_NO_SPEECH_STOP_MS = 8000;

/* The meter's resolution, and the two consumers of the same measurement: the
 * panel draws all of these bars, and the orb's four colours each take one range
 * of them. Both come from one spectrum, so the floating orb and the window can
 * never disagree about what the microphone is hearing. */
const SPECTRUM_BANDS = 48;
const CLOUD_HZ = [
  [90, 260],
  [260, 800],
  [800, 2400],
  [2400, 7200]
];

/* Blue is the app's "working" state, and opening the microphone is work: the user
 * must not start talking into a microphone that is not live yet. The warm palette is
 * reserved for the moment it actually is. */
const PALETTE_FOR = { starting: 'busy', listening: 'live', processing: 'busy', done: 'done', error: 'failed' };

let stream = null;
let audioCtx = null;
let sourceNode = null;
let captureNode = null;
let sinkNode = null;
let analyser = null;
let graphReady = null;
const meter = GuyaAudio.createLevelMeter();
const bandNormalizer = GuyaAudio.createBandNormalizer(SPECTRUM_BANDS);
const levels = new Array(SPECTRUM_BANDS).fill(0);
let timeBuf = null;
let freqBuf = null;
let pumpTimer = null;
let lastPumpAt = 0;
let lastSentAt = 0;
let voiceLevel = 0;
let chunks = [];
let captureRate = 0;
let capturing = false;
let starting = false;
let pendingStop = false;
let sessionToken = 0;
let flushing = false;
let flushWaiter = null;
let bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
let silenceStopMs = DEFAULT_SILENCE_STOP_MS; // after the user has spoken
let noSpeechStopMs = DEFAULT_NO_SPEECH_STOP_MS; // nobody has spoken yet
let voiceMs = 0;
let gate = null;
let endpointer = null;
let lastGate = null;
let frameVoiced = []; // one flag per entry of `chunks`
let lastRoomFloor = 0.002; // the room is the same for the next recording: start where we left off

const orb = GuyaOrb.create(canvas, {
  box: BOX,
  sphere: ORB_R,
  palette: 'live',
  onFrame: () => {
    orb.setLevels(bands);
    orb.setLevel(voiceLevel);
  }
});

/* ------------------------------------------------------------ level loop -- */

/* The measurement runs on a timer, not on a frame: a hidden window has its frames
 * paused, and the panel's meter would freeze with it while the orb kept listening.
 * Everything the orb and the panel show comes from here. */
function pump() {
  if (!analyser || !capturing) return;
  if (!timeBuf) {
    timeBuf = new Float32Array(analyser.fftSize);
    freqBuf = new Float32Array(analyser.frequencyBinCount);
  }
  const now = performance.now();
  const dt = Math.min(100, now - lastPumpAt || 16);
  lastPumpAt = now;

  analyser.getFloatTimeDomainData(timeBuf);
  voiceLevel = meter.push(GuyaAudio.rms(timeBuf), lastGate ? lastGate.floor : lastRoomFloor, dt);

  analyser.getFloatFrequencyData(freqBuf);
  bandNormalizer(GuyaAudio.spectrumDb(freqBuf, audioCtx.sampleRate, SPECTRUM_BANDS), dt, levels);
  const clouds = GuyaAudio.foldBands(levels, audioCtx.sampleRate, CLOUD_HZ);
  for (let i = 0; i < bands.length; i++) bands[i] = Math.max(GuyaOrb.REST, clouds[i]);

  if (now - lastSentAt >= 33) { // ~30 Hz to the panel, from a timer, so a hidden overlay still feeds it
    lastSentAt = now;
    api.sendSpectrum(levels);
  }
}

function startPump() {
  stopPump();
  lastPumpAt = performance.now();
  pumpTimer = setInterval(pump, 16);
}

function stopPump() {
  if (pumpTimer) clearInterval(pumpTimer);
  pumpTimer = null;
  levels.fill(0);
  voiceLevel = 0;
  meter.reset();
}

function setState(name, text) {
  stage.dataset.state = name;
  messageEl.textContent = text || '';
  messageEl.classList.toggle('show', !!text);

  if (name === 'idle') {
    orb.stop();
    return;
  }
  orb.setDriven(name === 'listening');
  orb.setProcessing(name === 'processing');
  /* The switch to warm at the instant the microphone goes live is the signal the user
   * waits for, so it is quick; everything else blends slowly. */
  orb.setPalette(PALETTE_FOR[name] || 'live', name === 'listening' ? 120 : 600);
  orb.start();
}

/* ------------------------------------------------------------- capture ----- */

/* Everything a recording measures, reset at the start of it: the gate that decides
 * what is speech, and the endpointer that decides when the recording is over. The
 * room's quiet level is remembered between recordings — it is the same room — so the
 * second recording of a session starts already knowing what the noise sounds like. */
function beginMeasuring() {
  gate = GuyaAudio.createVoiceGate({ initialFloor: lastRoomFloor });
  endpointer = GuyaAudio.createEndpointer({ noSpeechMs: noSpeechStopMs, endSilenceMs: silenceStopMs });
  lastGate = null;
  chunks = [];
  frameVoiced = [];
  voiceMs = 0;
}

function onChunk(chunk) {
  if ((!capturing && !flushing) || !gate) return;
  const frameMs = (chunk.length / (captureRate || GuyaAudio.TARGET_RATE)) * 1000;
  const g = gate.push(GuyaAudio.rms(chunk), frameMs);
  lastGate = g;
  if (g.voiced) voiceMs += frameMs + g.creditMs; // creditMs repays the onset frames that were not yet flagged
  chunks.push(chunk);
  frameVoiced.push(g.voiced);
  if (flushing) return; // the tail is audio, not a new reason to stop
  const reason = endpointer.push(g.voiced, frameMs);
  if (reason) {
    api.overlayAutoStopped(reason); // first: the main process must be ready for the audio that follows
    stopCapture();
  }
}

function micErrorKey(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'error.micDenied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'error.micNotFound';
  if (name === 'NotReadableError') return 'error.micBusy';
  return 'error.micFailed';
}

async function openMic(token) {
  /* Everything that does not need the device is built at boot, so the only thing
   * between the user's keypress and a live microphone is the device itself. The
   * graph is resumed beside the device request rather than after it: the context is
   * suspended when nothing is recording, and resuming it is a second wait the user
   * would pay on top of the device opening. */
  const prepared = prepareGraph();
  cancelIdleSuspend();
  const resumed = prepared
    .then(() => (audioCtx && audioCtx.state === 'suspended' ? audioCtx.resume() : null))
    .catch(() => {});

  let opened;
  try {
    opened = await navigator.mediaDevices.getUserMedia({ audio: GuyaAudio.MIC_CONSTRAINTS });
  } catch (err) {
    reportFailure(err);
    return false;
  }
  /* The user gave up, or a new recording started, while the device was opening:
   * this stream belongs to nobody, and leaving it open leaves the microphone on. */
  if (token !== sessionToken) {
    opened.getTracks().forEach((track) => track.stop());
    return false;
  }
  stream = opened;

  try {
    await prepared;
    await resumed;
    if (token !== sessionToken) {
      releaseMic();
      return false;
    }
    if (!audioCtx || !captureNode || !analyser) throw new Error('audio graph unavailable');
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    sourceNode = audioCtx.createMediaStreamSource(stream);
    /* The worklet outlives the recording, and a partial chunk in it would be
     * prepended to this one. */
    if (captureNode.port) captureNode.port.postMessage('reset');
    sourceNode.connect(captureNode);
    sourceNode.connect(analyser);
    captureRate = audioCtx.sampleRate;
    /* A device that goes away mid-recording (unplugged, taken by another app) must
     * end the recording rather than record silence for five minutes. */
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => onDeviceLost(token);
    });
  } catch (err) {
    reportFailure(err);
    return false;
  }
  return true;
}

/* Hands over whatever the worklet is still holding, so the last fraction of a second
 * before the user pressed stop is part of the recording. Resolves when the worklet has
 * answered, or after a short wait — the answer is not worth a hung app. */
function flushCapture() {
  if (!captureNode || !captureNode.port) return Promise.resolve(); // the ScriptProcessor fallback has no port
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      flushWaiter = null;
      resolve();
    }, 150);
    flushWaiter = () => {
      clearTimeout(timer);
      resolve();
    };
    flushing = true;
    captureNode.port.postMessage('flush');
  });
}

function onDeviceLost(token) {
  if (token !== sessionToken || !capturing) return;
  if (voiceMs > 0) {
    api.overlayAutoStopped('device-lost'); // keep what was said
    stopCapture();
  } else {
    reportFailure('error.micNotFound');
  }
}

/* The main process said to stop now: release the microphone and forget the session. */
function abortCapture() {
  sessionToken++;
  capturing = false;
  starting = false;
  pendingStop = false;
  stopPump();
  chunks = [];
  frameVoiced = [];
  voiceMs = 0;
  gate = null;
  endpointer = null;
  releaseMic();
  bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
  orb.setDriven(false);
}

/* The context, the worklet and the analyser, once, as early as possible: building
 * them while the user is still deciding to record is what makes the start
 * immediate, and none of it touches the microphone. */
function prepareGraph() {
  if (graphReady) return graphReady;

  graphReady = (async () => {
    audioCtx = new AudioContext({ sampleRate: GuyaAudio.TARGET_RATE });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    captureRate = audioCtx.sampleRate;

    if (audioCtx.audioWorklet) {
      try {
        await audioCtx.audioWorklet.addModule('/renderer/overlay/capture-worklet.js');
        captureNode = new AudioWorkletNode(audioCtx, 'guya-capture');
        captureNode.port.onmessage = (event) => {
          if (event.data === 'flushed') {
            if (flushWaiter) {
              flushWaiter();
              flushWaiter = null;
            }
            return;
          }
          onChunk(event.data);
        };
      } catch (err) {
        console.warn('[guya] AudioWorklet unavailable, falling back to ScriptProcessor:', err && err.message);
        captureNode = null;
      }
    }
    if (!captureNode) {
      captureNode = audioCtx.createScriptProcessor(2048, 1, 1);
      captureNode.onaudioprocess = (event) => onChunk(new Float32Array(event.inputBuffer.getChannelData(0)));
    }

    /* A muted sink keeps the graph pulling without making any sound. */
    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;
    captureNode.connect(sinkNode);
    sinkNode.connect(audioCtx.destination);

    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0; // the meters do their own smoothing, and know how much time passed
    analyser.connect(sinkNode);
  })().catch((err) => {
    console.warn('[guya] could not prepare the audio graph:', err && err.message);
    graphReady = null;
  });

  return graphReady;
}

/* Closes the microphone straight away. The graph itself is left running for a while:
 * suspending it costs a resume on the next recording, and a context with no source
 * connected costs nothing worth measuring. It is suspended later, on a timer — which
 * is also what keeps the context alive while a recording is being transcribed. */
function releaseMic() {
  try {
    if (sourceNode) sourceNode.disconnect();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  } catch (_) {
    /* the stream may already be gone */
  }
  sourceNode = null;
  stream = null;
  scheduleIdleSuspend();
}

let idleTimer = null;

function scheduleIdleSuspend() {
  cancelIdleSuspend();
  idleTimer = setTimeout(() => {
    if (!capturing && !starting && audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
  }, 30000);
}

function cancelIdleSuspend() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

async function reportFailure(err) {
  capturing = false;
  starting = false;
  pendingStop = false;
  stopPump();
  sessionToken++; // any openMic() still in flight is nobody's now
  flushing = false;
  if (flushWaiter) {
    flushWaiter();
    flushWaiter = null;
  }
  releaseMic();
  bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
  setState('error', '');
  // The main process localizes the message and sends it back as a flash.
  await api.overlayFailed(err && err.name ? micErrorKey(err) : typeof err === 'string' ? err : 'error.micFailed');
}

async function startCapture() {
  if (capturing || starting) return; // re-entrancy: one microphone owner, one session
  starting = true;
  const token = ++sessionToken;
  pendingStop = false;
  bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
  setState('starting', '');

  captureRate = 0;
  const opened = await openMic(token);
  starting = false;
  if (!opened || token !== sessionToken) return;

  beginMeasuring();
  capturing = true;
  startPump();
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

  const token = sessionToken;
  await flushCapture();
  flushing = false;
  if (token !== sessionToken) return; // abortCapture()/reportFailure() ran while we waited: nobody wants this result

  const rate = captureRate || GuyaAudio.TARGET_RATE;
  let samples = 0;
  for (let i = 0; i < chunks.length; i++) samples += chunks[i].length;
  const durationMs = Math.round((samples / rate) * 1000); // what the timer shows
  const trimmed = GuyaAudio.trimToSpeech(chunks, frameVoiced, rate, 450, 450); // what is uploaded
  const spokenMs = Math.round(voiceMs);
  stopPump();
  if (lastGate) lastRoomFloor = Math.min(0.02, Math.max(0.0005, lastGate.floor));
  chunks = [];
  frameVoiced = [];
  voiceMs = 0;
  gate = null;
  endpointer = null;
  releaseMic();

  let wav;
  try {
    wav = trimmed.samples.length ? GuyaAudio.wavFromFloat32(trimmed.samples, rate) : new Uint8Array(0);
  } catch (err) {
    return reportFailure('error.micFailed');
  }

  /* How much of it was speech travels with the audio: a recording of a quiet room
   * is not something to ask a model about. So does how much of it is being sent,
   * which is the trimmed length rather than the length the timer counted. */
  api.overlayResult(wav, durationMs, spokenMs, trimmed.trimmedMs);
}

/* -------------------------------------------------------------- commands --- */

api.onOverlayCommand((payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'start') {
    if (Number.isFinite(payload.silenceStopMs)) silenceStopMs = payload.silenceStopMs;
    if (Number.isFinite(payload.noSpeechStopMs)) noSpeechStopMs = payload.noSpeechStopMs;
    startCapture();
  } else if (payload.type === 'stop') {
    stopCapture();
  } else if (payload.type === 'abort') {
    abortCapture();
  } else if (payload.type === 'flash') {
    // The main process sends a key; this window owns the words, in whatever
    // language the interface is in right now.
    const text = payload.messageKey ? GuyaI18n.t(payload.language, payload.messageKey, payload.messageVars) : '';
    setState(payload.state === 'error' ? 'error' : 'done', text);
  }
});

/* ------------------------------------------------------------------ boot --- */

/* Preparing the audio graph costs a context, a worklet fetch and a compile, none
 * of which needs the microphone. Doing it now is what makes the start instant. */
prepareGraph();

window.addEventListener('resize', () => orb.resize());
