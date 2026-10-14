/*
 * AudioWorklet that collects microphone samples off the main thread and posts
 * them to the overlay in fixed chunks (1024 frames ≈ 21 ms at 48 kHz). Stereo
 * input is averaged down to mono here so the renderer only deals with one array.
 */
class GuyaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const first = input[0];
    if (!first) return true;

    const channelCount = input.length;
    for (let i = 0; i < first.length; i++) {
      let value = first[i];
      for (let c = 1; c < channelCount; c++) value += input[c][i];
      if (channelCount > 1) value /= channelCount;

      this.chunk[this.filled++] = value;
      if (this.filled === this.chunk.length) {
        const out = this.chunk;
        this.chunk = new Float32Array(out.length);
        this.filled = 0;
        this.port.postMessage(out, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('guya-capture', GuyaCapture);
