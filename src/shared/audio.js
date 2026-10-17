/*
 * Audio helpers shared between the renderer (browser globals) and Node (require).
 * No dependencies: everything needed to turn raw microphone samples into a
 * 16 kHz mono 16-bit WAV that the Gemini API accepts.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GuyaAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TARGET_RATE = 16000;

  /* What to ask the microphone for.
   *
   * Echo cancellation stays off: it selects the system's voice-processing unit,
   * which is built for calls and gates quiet speech. Everything else is left at the
   * platform's default, and that is deliberate — measured on this machine with
   * speech playing, the raw signal arrives at about a fourteenth of the level the
   * platform's automatic gain produces (0.009 against 0.128 RMS), which is quiet
   * enough that speech stops being recognisable as speech at all. An app that
   * hears nothing is worse than one that hears a processed voice. */
  var MIC_CONSTRAINTS = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: true
  };

  /* A band level for every bar in the meter, 0-1. */
  function floatToInt16(input) {
    var out = new Int16Array(input.length);
    for (var i = 0; i < input.length; i++) {
      var s = input[i];
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function concatFloat32(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Float32Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) {
      out.set(chunks[j], offset);
      offset += chunks[j].length;
    }
    return out;
  }

  function resample(input, inputRate, outputRate) {
    if (inputRate === outputRate || input.length === 0) return input;
    var ratio = inputRate / outputRate;
    var outLength = Math.max(1, Math.round(input.length / ratio));
    var out = new Float32Array(outLength);
    var last = input.length - 1;
    for (var i = 0; i < outLength; i++) {
      var pos = i * ratio;
      var i0 = pos | 0;
      if (i0 > last) i0 = last;
      var i1 = i0 + 1 > last ? last : i0 + 1;
      var frac = pos - i0;
      out[i] = input[i0] * (1 - frac) + input[i1] * frac;
    }
    return out;
  }

  /* Microphone samples -> 16 kHz mono, the format Gemini wants for audio. */
  function msToTargetRate(samples, sampleRate) {
    return resample(samples, sampleRate, TARGET_RATE);
  }

  function writeAscii(view, offset, text) {
    for (var i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  function encodeWav(int16, sampleRate) {
    var dataBytes = int16.length * 2;
    var buffer = new ArrayBuffer(44 + dataBytes);
    var view = new DataView(buffer);
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // PCM chunk size
    view.setUint16(20, 1, true); // format: PCM
    view.setUint16(22, 1, true); // channels: mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
    new Int16Array(buffer, 44, int16.length).set(int16);
    return new Uint8Array(buffer);
  }

  /* float samples -> ready-to-upload 16 kHz mono WAV bytes */
  function wavFromFloat32(samples, sampleRate) {
    var resampled = msToTargetRate(samples, sampleRate);
    return encodeWav(floatToInt16(resampled), TARGET_RATE);
  }

  function rms(samples) {
    if (!samples.length) return 0;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function durationSeconds(byteLength) {
    return Math.max(0, (byteLength - 44) / 2 / TARGET_RATE);
  }

  /* ------------------------------------------------------------- spectrum --- */

  /* The meter is a spectrum, not a history of loudness: each bar is one frequency
   * band, so a voice at 1 kHz moves the bars around 1 kHz and leaves the rest alone.
   *
   * Mel spacing rather than log: an octave is not what the ear counts. With 48 bars
   * over 80 Hz to the top of the range, the lowest band is about three bins wide at a
   * 16 kHz context, so the bars at the bottom are real measurements rather than the
   * same bin drawn twice. */
  var SPECTRUM_LOW_HZ = 80;
  var SPECTRUM_HIGH_HZ = 16000;

  function hzToMel(f) { return 2595 * Math.log10(1 + f / 700); }
  function melToHz(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

  function bandEdges(sampleRate, bandCount, lowHz, highHz) {
    var low = Math.max(1, lowHz || SPECTRUM_LOW_HZ);
    var high = Math.min((sampleRate / 2) * 0.95, highHz || SPECTRUM_HIGH_HZ);
    var m0 = hzToMel(low), m1 = hzToMel(high), edges = [];
    for (var i = 0; i <= bandCount; i++) edges.push(melToHz(m0 + (m1 - m0) * (i / bandCount)));
    return edges;
  }

  /* freqDb: what AnalyserNode.getFloatFrequencyData gives, in dB. The result is the
   * mean power of each band, also in dB.
   *
   * The bins are partitioned, not overlapped: a band owns the bins from the one at or
   * above its lower edge to the one before its upper edge. Taking the bin that
   * contains the edge for both neighbours makes a pure tone light two bars equally,
   * and the meter then shows a peak that moves between them. Near the bottom two
   * edges fall inside the same bin, so a band keeps at least one. */
  function spectrumDb(freqDb, sampleRate, bandCount, lowHz, highHz) {
    var edges = bandEdges(sampleRate, bandCount, lowHz, highHz);
    var n = freqDb.length, perBin = sampleRate / 2 / n, out = new Array(bandCount);
    for (var b = 0; b < bandCount; b++) {
      var from = Math.max(0, Math.min(n - 1, Math.ceil(edges[b] / perBin)));
      var to = Math.max(from, Math.min(n - 1, Math.ceil(edges[b + 1] / perBin) - 1));
      var power = 0;
      for (var i = from; i <= to; i++) power += Math.pow(10, Math.max(-120, freqDb[i]) / 10);
      out[b] = 10 * Math.log10(power / (to - from + 1) + 1e-12);
    }
    return out;
  }

  /* One band per cloud in the orb: the same measurement, folded into the ranges
   * the sphere's colours are driven by. The band indices come from the same edges
   * `spectrum` used, so the two stay aligned whatever the context's rate is —
   * which matters because the top of the spectrum is the Nyquist frequency, and a
   * 16 kHz context cannot see 16 kHz. */
  function foldBands(levels, sampleRate, rangesHz) {
    var edges = bandEdges(sampleRate, levels.length);
    return rangesHz.map(function (range) {
      var from = 0;
      while (from < levels.length - 1 && edges[from + 1] <= range[0]) from++;
      var to = from + 1;
      while (to < levels.length && edges[to] < range[1]) to++;
      var best = 0;
      for (var i = from; i < to; i++) if (levels[i] > best) best = levels[i];
      return best;
    });
  }

  /* ------------------------------------------------------------- meters --- */

  /* The meter and the orb both need "how loud is this, compared to the room?", and
   * both used to get a copy of the analyser's byte data raised to a power. Bytes are
   * decibels already, with limits of -100 and -30 dB fixed by the browser, so the
   * same face was 40% of the meter in a quiet room and 90% in a noisy one, and there
   * was no way to tell a fan from a voice.
   *
   * These work in decibels relative to what the gate measured, normalised against a
   * peak that falls slowly: a bar is loud when it is loud *for this room*, and noise
   * sits at zero instead of halfway up. Attack and release are time constants, so the
   * response does not depend on the frame rate. */
  function createLevelMeter(options) {
    var o = { attackMs: 25, releaseMs: 220, minSpanDb: 14, ceilFallDbPerSec: 4, gamma: 0.85, aboveFloor: 1.8 };
    if (options) for (var k in options) o[k] = options[k];
    var envelope = 0, ceilDb = -35;
    return {
      /* rms: this frame's level; floorRms: the gate's room estimate; dtMs: time since
       * the last call. Returns 0..1. */
      push: function (rms, floorRms, dtMs) {
        var db = 20 * Math.log10(Math.max(rms, 1e-5));
        var lowDb = 20 * Math.log10(Math.max(floorRms * o.aboveFloor, 1e-4));
        ceilDb = db > ceilDb ? db : Math.max(ceilDb - (o.ceilFallDbPerSec * dtMs) / 1000, lowDb + o.minSpanDb);
        var x = Math.max(0, Math.min(1, (db - lowDb) / Math.max(1, ceilDb - lowDb)));
        x = Math.pow(x, o.gamma);
        var tau = x > envelope ? o.attackMs : o.releaseMs;
        envelope += (x - envelope) * (1 - Math.exp(-dtMs / tau));
        return envelope;
      },
      reset: function () { envelope = 0; ceilDb = -35; }
    };
  }

  /* The same idea for every bar of the spectrum: each band keeps its own smoothed
   * level, its own floor and its own falling ceiling, so a band moves when there is
   * energy in it *for that band* — which is what makes the row read as a spectrum
   * instead of a shape that follows the loudness. */
  function createBandNormalizer(count, options) {
    var o = { floorRiseDbPerSec: 2.5, ceilFallDbPerSec: 5, minSpanDb: 14, marginDb: 6, gamma: 0.8, attackMs: 30, releaseMs: 200, smoothMs: 60 };
    if (options) for (var k in options) o[k] = options[k];
    var smooth = new Array(count), floor = new Array(count), ceil = new Array(count), env = new Array(count), ready = false;
    function normalize(dbBands, dtMs, out) {
      var dt = dtMs / 1000, a = 1 - Math.exp(-dtMs / o.smoothMs);
      for (var b = 0; b < count; b++) {
        var db = dbBands[b];
        if (!ready) { smooth[b] = db; floor[b] = db; ceil[b] = db + o.minSpanDb + o.marginDb; env[b] = 0; }
        smooth[b] += (db - smooth[b]) * a;
        var s = smooth[b];
        floor[b] = s < floor[b] ? s : Math.min(s, floor[b] + o.floorRiseDbPerSec * dt);
        ceil[b] = s > ceil[b] ? s : Math.max(floor[b] + o.marginDb + o.minSpanDb, ceil[b] - o.ceilFallDbPerSec * dt);
        var x = (s - floor[b] - o.marginDb) / Math.max(1, ceil[b] - floor[b] - o.marginDb);
        x = Math.pow(Math.max(0, Math.min(1, x)), o.gamma);
        env[b] += (x - env[b]) * (1 - Math.exp(-dtMs / (x > env[b] ? o.attackMs : o.releaseMs)));
        out[b] = env[b];
      }
      ready = true;
      return out;
    }
    /* A band's floor and ceiling are learned from what it has heard. After a loud
     * recording the next one starts with that memory, and its first seconds are drawn
     * as if they were quiet — so a new recording starts by forgetting. */
    normalize.reset = function () {
      ready = false;
    };
    return normalize;
  }

  /* --------------------------------------------------------------- trim --- */

  /* Keeps the speech and a little air around it: the silence before the first word
   * and after the last one is uploaded too, and on a slow connection it is the most
   * expensive part of the recording. The padding is deliberate — the gate flags
   * speech only after a 100 ms onset and keeps a 400 ms hang-over, so the edges of
   * the words the gate knows about are already inside these margins.
   * `voiced` has one flag per chunk. */
  function trimToSpeech(chunks, voiced, rate, padBeforeMs, padAfterMs) {
    var first = -1, last = -1;
    for (var i = 0; i < voiced.length; i++) if (voiced[i]) { if (first < 0) first = i; last = i; }
    if (first < 0) return { samples: new Float32Array(0), trimmedMs: 0 };
    var frameMs = (chunks[0].length / rate) * 1000;
    var from = Math.max(0, first - Math.ceil(padBeforeMs / frameMs));
    var to = Math.min(chunks.length - 1, last + Math.ceil(padAfterMs / frameMs));
    var samples = concatFloat32(chunks.slice(from, to + 1));
    return { samples: samples, trimmedMs: Math.round((samples.length / rate) * 1000) };
  }

  /* --------------------------------------------------------------- gain --- */

  /* Gain a quiet WAV (16-bit PCM, 44-byte header) up to a target peak; returns the SAME
   * object when no useful gain exists. Used when the model says it heard no speech but
   * the app measured some: asking again with the identical audio at temperature 0 would
   * produce the identical answer, so the second attempt is the same recording, louder. */
  function normalizeWavPeak(wav, target, maxGain) {
    var tgt = (target || 0.89) * 32767, cap = maxGain || 8;
    var n = (wav.byteLength - 44) >> 1;
    var view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    var peak = 0, i;
    for (i = 0; i < n; i++) { var s = Math.abs(view.getInt16(44 + i * 2, true)); if (s > peak) peak = s; }
    if (peak < 1) return wav;
    var gain = Math.min(cap, tgt / peak);
    if (gain <= 1.2) return wav;
    var out = new Uint8Array(wav.byteLength); out.set(wav);
    var ov = new DataView(out.buffer);
    for (i = 0; i < n; i++) {
      var v = Math.round(view.getInt16(44 + i * 2, true) * gain);
      ov.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, v)), true);
    }
    return out;
  }

  /* --------------------------------------------------------- voice gate --- */

  /* Is this the room, or is this someone talking?
   *
   * The level the room sits at depends on the microphone, the platform's gain and the
   * room itself, so nothing here is an absolute number: the floor is a LOW QUANTILE of
   * the last two and a half seconds — what the room sounds like, not the single
   * quietest frame it ever managed, which one silent buffer from a driver could pin at
   * nothing for a whole session.
   *
   * It follows a quieter room at once, and rises when nobody is talking, or when the
   * whole window is steady: a fan, a hiss or the platform's gain settling are steady,
   * while speech modulates far too much to look steady. While a voice is present the
   * floor may rise only very slowly (5% a second), because otherwise a long sentence
   * raises its own threshold and goes quiet in the middle of the sentence.
   *
   * Speech has to clear the threshold for a tenth of a second to count (a keyboard
   * click is one frame), and four tenths of a second of hang-over keep the gaps
   * between words from ending it. Both are counted in audio time rather than
   * wall-clock time, so this behaves the same in a test and in a slow renderer. */
  function createVoiceGate(options) {
    var o = { windowMs: 2500, minThreshold: 0.0025, onsetRatio: 3.0, offsetRatio: 2.0, onsetMs: 100, hangMs: 400,
              initialFloor: 0.002, hardFloor: 0.0003, steadyMs: 800, steadyRatio: 2.2, quantile: 0.2,
              minFrames: 5, voicedRisePerSec: 1.05 };
    if (options) for (var k in options) o[k] = options[k];
    var win = [], clock = 0, floor = o.initialFloor, voiced = false, onsetRun = 0, hang = 0;
    function push(rms, frameMs) {
      clock += frameMs;
      win.push([clock, rms]);
      while (win.length && win[0][0] < clock - o.windowMs) win.shift();
      var low = Infinity, high = 0;
      for (var i = 0; i < win.length; i++) { if (win[i][1] < low) low = win[i][1]; if (win[i][1] > high) high = win[i][1]; }
      var span = win.length > 1 ? clock - win[0][0] : 0;
      var steady = span >= o.steadyMs && high <= low * o.steadyRatio;
      if (win.length >= o.minFrames) {
        var sorted = win.map(function (e) { return e[1]; }).sort(function (a, b) { return a - b; });
        var target = Math.max(sorted[Math.floor((sorted.length - 1) * o.quantile)], o.hardFloor);
        if (target <= floor) floor = target;
        else if (steady) floor = target;
        else if (clock >= o.windowMs && !voiced) floor = target;
        else if (clock >= o.windowMs && voiced) floor = Math.min(target, floor * Math.pow(o.voicedRisePerSec, frameMs / 1000));
      }
      var on = Math.max(o.minThreshold, floor * o.onsetRatio);
      var off = Math.max(o.minThreshold * 0.6, floor * o.offsetRatio);
      var credit = 0;
      if (voiced) {
        if (rms >= off) hang = o.hangMs;
        else { hang -= frameMs; if (hang <= 0) { voiced = false; onsetRun = 0; } }
      } else if (rms >= on) {
        onsetRun += frameMs;
        if (onsetRun >= o.onsetMs) { voiced = true; hang = o.hangMs; credit = onsetRun - frameMs; }
      } else onsetRun = 0;
      return { voiced: voiced, floor: floor, threshold: on, creditMs: credit };
    }
    return { push: push };
  }

  function createEndpointer(options) {
    var o = { noSpeechMs: 8000, endSilenceMs: 3000 };
    if (options) for (var k in options) o[k] = options[k];
    var heard = false, quiet = 0, waited = 0;
    return {
      push: function (voiced, frameMs) {
        if (voiced) { heard = true; quiet = 0; return null; }
        if (heard) { quiet += frameMs; return o.endSilenceMs > 0 && quiet >= o.endSilenceMs ? 'end-of-speech' : null; }
        waited += frameMs; return o.noSpeechMs > 0 && waited >= o.noSpeechMs ? 'no-speech' : null;
      },
      heardSpeech: function () { return heard; }
    };
  }

  return {
    TARGET_RATE: TARGET_RATE,
    MIC_CONSTRAINTS: MIC_CONSTRAINTS,
    SPECTRUM_LOW_HZ: SPECTRUM_LOW_HZ,
    SPECTRUM_HIGH_HZ: SPECTRUM_HIGH_HZ,
    createLevelMeter: createLevelMeter,
    createBandNormalizer: createBandNormalizer,
    floatToInt16: floatToInt16,
    concatFloat32: concatFloat32,
    resample: resample,
    msToTargetRate: msToTargetRate,
    encodeWav: encodeWav,
    wavFromFloat32: wavFromFloat32,
    rms: rms,
    durationSeconds: durationSeconds,
    trimToSpeech: trimToSpeech,
    normalizeWavPeak: normalizeWavPeak,
    createVoiceGate: createVoiceGate,
    createEndpointer: createEndpointer,
    bandEdges: bandEdges,
    spectrumDb: spectrumDb,
    foldBands: foldBands
  };
});
