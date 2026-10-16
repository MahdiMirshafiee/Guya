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

  /* One-pole high-pass used to remove DC offset and low rumble. Kept as a
   * utility, but deliberately not part of the capture path: starting the filter
   * from zero adds a short transient that overshoots the input by ~5% on the
   * first milliseconds, and untouched audio transcribes better. */
  function highPass(input, sampleRate, cutoff) {
    if (!input.length) return input;
    cutoff = cutoff || 70;
    var dt = 1 / sampleRate;
    var rc = 1 / (2 * Math.PI * cutoff);
    var alpha = rc / (rc + dt);
    var out = new Float32Array(input.length);
    var prevIn = input[0];
    var prevOut = 0;
    for (var i = 0; i < input.length; i++) {
      var x = input[i];
      var y = alpha * (prevOut + x - prevIn);
      out[i] = y;
      prevIn = x;
      prevOut = y;
    }
    return out;
  }

  /* Linear resampling. Speech transcription at 16 kHz does not need anything
   * fancier, and this stays dependency-free on every platform. */
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
   * band, so a voice at 1 kHz moves the bars around 1 kHz and leaves the rest
   * alone. Bands are spaced logarithmically — an octave takes the same room on
   * screen as the octave below it — over the range speech occupies.
   *
   * `bins` is what AnalyserNode.getByteFrequencyData gives (0-255 per bin) and
   * `sampleRate` is the context's rate; the result is 0-1 per band, shaped so
   * quiet speech still shows. */
  var SPECTRUM_LOW_HZ = 60;
  var SPECTRUM_HIGH_HZ = 16000;

  function bandEdges(sampleRate, bandCount, lowHz, highHz) {
    var low = Math.max(1, lowHz || SPECTRUM_LOW_HZ);
    var high = Math.min(sampleRate / 2, highHz || SPECTRUM_HIGH_HZ);
    var edges = [];
    for (var i = 0; i < bandCount; i++) edges.push(low * Math.pow(high / low, i / bandCount));
    edges.push(high);
    return edges;
  }

  function spectrum(bins, sampleRate, bandCount, lowHz, highHz) {
    var edges = bandEdges(sampleRate, bandCount, lowHz, highHz);
    var binCount = bins.length;
    var perBin = sampleRate / 2 / (binCount || 1);
    var out = new Array(bandCount);
    for (var b = 0; b < bandCount; b++) {
      /* Bins are partitioned, not overlapped: a band owns the bins at or after its
       * lower edge and before its upper one, so a pure tone lights one bar instead
       * of two. Near the bottom two edges fall inside the same bin, and a band over
       * an empty range would sit dead forever, so each band keeps at least one. */
      var from = Math.max(0, Math.min(binCount - 1, Math.ceil(edges[b] / perBin)));
      var to = Math.max(from, Math.min(binCount - 1, Math.ceil(edges[b + 1] / perBin) - 1));
      var sum = 0;
      var count = 0;
      for (var bin = from; bin <= to; bin++) {
        sum += bins[bin];
        count++;
      }
      var average = count ? sum / count / 255 : 0;
      out[b] = Math.min(1, Math.pow(average, 0.62) * 1.25);
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

  /* --------------------------------------------------------- voice gate --- */

  /* Two jobs that used to be one measurement, done properly.
   *
   * The gate answers "is this the room, or is this someone talking?" with a floor
   * that follows the room in BOTH directions: it is the quietest frame of the last
   * two and a half seconds, so a fan starting or automatic gain settling cannot
   * leave it behind — the previous version could only ever move down, which made its
   * threshold a constant in any room with steady noise. While a voice is present it
   * rises at most 1.3x per second, except when the signal is *steady* (its peak
   * barely moves over most of a second): that is a fan or a hiss, not speech, and
   * speech modulates far too much to look like it.
   *
   * The endpointer answers "are they finished?" with two different waits, because
   * "nobody has spoken yet" and "they have stopped speaking" are not the same
   * question: waiting ten seconds for the first is ten seconds of the user's life
   * and ten seconds of silence uploaded to the provider.
   *
   * Both are pure and count audio time rather than wall-clock time, so they behave
   * the same in a test and in a slow renderer. */
  function createVoiceGate(options) {
    var o = { windowMs: 2500, minThreshold: 0.0035, onsetRatio: 3.5, offsetRatio: 2.2, onsetMs: 100, hangMs: 400, voicedRisePerSec: 1.3, initialFloor: 0.002, hardFloor: 0.0003, steadyMs: 800, steadyRatio: 2.2 };
    if (options) for (var k in options) o[k] = options[k];
    var history = [], clock = 0, floor = o.initialFloor, voiced = false, onsetRun = 0, hang = 0;
    function push(rms, frameMs) {
      clock += frameMs;
      history.push([clock, rms]);
      while (history.length && history[0][0] < clock - o.windowMs) history.shift();
      var low = Infinity, high = 0;
      for (var i = 0; i < history.length; i++) {
        if (history[i][1] < low) low = history[i][1];
        if (history[i][1] > high) high = history[i][1];
      }
      var target = Math.max(low, o.hardFloor);
      /* Steady sound (a fan, hiss, AGC gain settling) barely moves from frame to frame; speech does. */
      var span = history.length > 1 ? clock - history[0][0] : 0;
      var steady = span >= o.steadyMs && high <= low * o.steadyRatio;
      if (target <= floor) floor = target;
      else if (steady) floor = target;
      else if (clock >= o.windowMs) floor = voiced ? Math.min(target, floor * Math.pow(o.voicedRisePerSec, frameMs / 1000)) : target;
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
    floatToInt16: floatToInt16,
    concatFloat32: concatFloat32,
    highPass: highPass,
    resample: resample,
    msToTargetRate: msToTargetRate,
    encodeWav: encodeWav,
    wavFromFloat32: wavFromFloat32,
    rms: rms,
    durationSeconds: durationSeconds,
    trimToSpeech: trimToSpeech,
    createVoiceGate: createVoiceGate,
    createEndpointer: createEndpointer,
    bandEdges: bandEdges,
    spectrum: spectrum,
    foldBands: foldBands
  };
});
