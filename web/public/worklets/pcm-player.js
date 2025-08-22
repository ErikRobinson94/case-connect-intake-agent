// public/worklets/pcm-player.js
// Streams Float32 mono audio smoothly using a simple queue.

class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;

    // Main thread sends ArrayBuffer containing Float32 samples
    this.port.onmessage = (e) => {
      const chunk = new Float32Array(e.data);
      if (chunk && chunk.length) this.queue.push(chunk);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0]; // mono
    let i = 0;

    while (i < out.length) {
      if (this.queue.length === 0) {
        // underrun: fill with silence
        out[i++] = 0;
        continue;
      }
      const cur = this.queue[0];
      const remaining = cur.length - this.offset;
      const toCopy = Math.min(remaining, out.length - i);

      out.set(cur.subarray(this.offset, this.offset + toCopy), i);
      i += toCopy;
      this.offset += toCopy;

      if (this.offset >= cur.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true; // keep alive
  }
}

registerProcessor('pcm-player', PCMPlayer);
