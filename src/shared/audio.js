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

  return {
    TARGET_RATE: TARGET_RATE,
    floatToInt16: floatToInt16,
    concatFloat32: concatFloat32,
    highPass: highPass,
    resample: resample,
    msToTargetRate: msToTargetRate,
    encodeWav: encodeWav,
    wavFromFloat32: wavFromFloat32,
    rms: rms,
    durationSeconds: durationSeconds
  };
});
