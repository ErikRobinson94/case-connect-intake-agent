// AudioWorkletProcessor that plays Float32 PCM chunks pushed from main thread.
// The main thread sends Float32Array buffers already at the AudioContext rate.
class PCMPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];       // array of Float32Array chunks
    this.readIndex = 0;    // index into the first chunk
    this.port.onmessage = (e) => {
      const buf = e.data;
      if (buf instanceof ArrayBuffer) {
        const f32 = new Float32Array(buf);
        if (f32.length) this.queue.push(f32);
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;
    const out = output[0];              // mono
    const frames = out.length;

    let i = 0;
    while (i < frames) {
      if (!this.queue.length) {
        // underrun -> fill silence
        out[i++] = 0;
        continue;
      }
      const chunk = this.queue[0];
      out[i++] = chunk[this.readIndex++];
      if (this.readIndex >= chunk.length) {
        this.queue.shift();
        this.readIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PCMPlayer);
