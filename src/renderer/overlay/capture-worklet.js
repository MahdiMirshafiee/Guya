/*
 * AudioWorklet that collects microphone samples off the main thread and posts
 * them to the overlay in fixed chunks of 1024 frames — 64 ms at the 16 kHz
 * context the graph runs at. Stereo input is averaged down to mono here so the
 * renderer only deals with one array.
 *
 * The node outlives a recording, so the overlay can tell it two things: `reset`,
 * which throws away a partial chunk left over from the previous recording instead
 * of prepending it to the next one, and `flush`, which hands over the partial
 * chunk so the last fraction of a second before the user pressed stop is not lost.
 */
class GuyaCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(1024);
    this.filled = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'reset') {
        this.filled = 0; // forget a partial chunk left over from the previous recording
      } else if (event.data === 'flush') {
        if (this.filled > 0) {
          const out = this.chunk.slice(0, this.filled); // a copy: its buffer is transferred below
          this.filled = 0;
          this.port.postMessage(out, [out.buffer]);
        }
        this.port.postMessage('flushed'); // port messages arrive in order: the tail is already delivered
      }
    };
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
