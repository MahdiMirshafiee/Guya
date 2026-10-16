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

const PALETTE_FOR = { starting: 'live', listening: 'live', processing: 'busy', done: 'done', error: 'failed' };

let stream = null;
let audioCtx = null;
let sourceNode = null;
let captureNode = null;
let sinkNode = null;
let analyser = null;
let spectrumBins = null;
let graphReady = null;
let chunks = [];
let captureRate = 0;
let capturing = false;
let starting = false;
let pendingStop = false;
let sessionToken = 0;
let bands = [GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST, GuyaOrb.REST];
let levelTickAt = 0;
let silenceStopMs = DEFAULT_SILENCE_STOP_MS;
let lastVoiceAt = 0;
let voiceMs = 0;

/* Is this the room, or is this someone talking?
 *
 * A quiet room and a voice differ by a factor of six in level and by nothing at
 * all in zero-crossing rate or in how much the level moves — both were measured —
 * so the level is what this uses, against a floor that sits between them and rises
 * in a room that is loud all by itself. What was actually said, and whether
 * anything was, is still the model's answer to give: this decides only whether the
 * recording is worth asking about, and whether the room has gone quiet. */
const room = {
  quiet: GuyaAudio.SPEECH_RMS_FLOOR,
  update(rms) {
    if (rms < this.quiet) this.quiet = rms;
  },
  level() {
    return GuyaAudio.speechLevel(this.quiet);
  }
};

const orb = GuyaOrb.create(canvas, {
  box: BOX,
  sphere: ORB_R,
  palette: 'live',
  onFrame: () => {
    if (stage.dataset.state === 'listening') {
      const levels = readSpectrum();
      /* Twenty times a second is enough for the eye and keeps the channel quiet;
       * the orb itself is redrawn every frame from the same numbers. */
      const at = performance.now();
      if (levels && at - levelTickAt > 50) {
        levelTickAt = at;
        api.sendSpectrum(levels);
      }
    }
    orb.setLevels(bands);
  }
});

/* ------------------------------------------------------------ level loop -- */

function readSpectrum() {
  if (!analyser || !spectrumBins) return;
  const rate = captureRate || 48000;
  analyser.getByteFrequencyData(spectrumBins);
  const levels = GuyaAudio.spectrum(spectrumBins, rate, SPECTRUM_BANDS);
  const clouds = GuyaAudio.foldBands(levels, rate, CLOUD_HZ);
  for (let i = 0; i < bands.length; i++) {
    const target = Math.max(GuyaOrb.REST, clouds[i]);
    const previous = bands[i];
    bands[i] = target > previous ? previous + (target - previous) * 0.55 : previous + (target - previous) * 0.14;
  }
  return levels;
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

/* Every chunk of sound the microphone produces, whether or not a recording is
 * running: the level meter, the silence detector and the voice clock all read the
 * same samples, and the samples themselves are kept only while capturing. */
function onChunk(chunk) {
  const rms = GuyaAudio.rms(chunk);
  room.update(rms);
  const speaking = rms > room.level();

  if (capturing) {
    /* How much of this recording was actually someone talking: the main process
     * needs it to decide whether there is anything to transcribe at all. */
    if (speaking) {
      voiceMs += (chunk.length / (captureRate || 48000)) * 1000;
      lastVoiceAt = performance.now();
    } else if (silenceStopMs > 0 && performance.now() - lastVoiceAt > silenceStopMs) {
      // Tell the main process first, so it is ready to transcribe the result.
      api.overlayAutoStopped('end-of-speech');
      stopCapture();
    }
    if (capturing) chunks.push(chunk);
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
   * between the user's keypress and a live microphone is the device itself. */
  const prepared = prepareGraph();

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
    if (token !== sessionToken) {
      releaseMic();
      return false;
    }
    sourceNode = audioCtx.createMediaStreamSource(stream);
    sourceNode.connect(captureNode);
    sourceNode.connect(analyser);
    if (audioCtx.state === 'suspended') await audioCtx.resume();
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
  chunks = [];
  voiceMs = 0;
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
        captureNode.port.onmessage = (event) => onChunk(event.data);
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
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.65;
    spectrumBins = new Uint8Array(analyser.frequencyBinCount);
    analyser.connect(sinkNode);
  })().catch((err) => {
    console.warn('[guya] could not prepare the audio graph:', err && err.message);
    graphReady = null;
  });

  return graphReady;
}

/* Closes the microphone and leaves the graph ready for the next time. */
function releaseMic() {
  try {
    if (sourceNode) sourceNode.disconnect();
    if (stream) stream.getTracks().forEach((track) => track.stop());
  } catch (_) {
    /* the stream may already be gone */
  }
  sourceNode = null;
  stream = null;
  /* Nothing is being recorded: holding the output device open keeps the CPU awake
   * for nothing. The graph is rebuilt by prepareGraph() when it is needed again. */
  if (audioCtx && audioCtx.state === 'running') audioCtx.suspend().catch(() => {});
  if (spectrumBins) spectrumBins.fill(0);
}

async function reportFailure(err) {
  capturing = false;
  starting = false;
  pendingStop = false;
  sessionToken++; // any openMic() still in flight is nobody's now
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
  chunks = [];
  voiceMs = 0;
  lastVoiceAt = performance.now();
  setState('starting', '');

  captureRate = 0;
  const opened = await openMic(token);
  starting = false;
  if (!opened || token !== sessionToken) return;

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
  const spokenMs = Math.round(voiceMs);
  chunks = [];
  voiceMs = 0;
  releaseMic();

  let wav;
  try {
    wav = GuyaAudio.wavFromFloat32(samples, rate);
  } catch (err) {
    return reportFailure('error.micFailed');
  }

  /* How much of it was speech travels with the audio: a recording of a quiet room
   * is not something to ask a model about. */
  api.overlayResult(wav, durationMs, spokenMs);
}

/* -------------------------------------------------------------- commands --- */

api.onOverlayCommand((payload) => {
  if (!payload || typeof payload !== 'object') return;
  if (payload.type === 'start') {
    if (Number.isFinite(payload.silenceStopMs)) silenceStopMs = payload.silenceStopMs;
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
