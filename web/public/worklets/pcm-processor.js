// public/worklets/pcm-processor.js
// Resample mic to 16k mono Float32, chunk into 20ms (320 samples), convert to Int16LE,
// and post ArrayBuffers to the main thread.

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate;           // input device rate (often 48000)
    this.outRate = 16000;               // target
    this.ratio = this.inRate / this.outRate;

    // Resampling state
    this.srcCursor = 0;                 // fractional position into this.inBuf
    this.inBuf = new Float32Array(0);   // accumulated input
    this.hold = new Float32Array(0);    // leftover resampled floats not yet framed
  }

  // Linear resample a chunk from this.inBuf into 16k space
  _resampleAvailable() {
    const availableSrc = this.inBuf.length - 1; // need +1 for linear interp
    if (availableSrc <= 0) return new Float32Array(0);

    const maxOut = Math.floor((availableSrc - this.srcCursor) / this.ratio);
    if (maxOut <= 0) return new Float32Array(0);

    const out = new Float32Array(maxOut);
    let pos = this.srcCursor;

    for (let i = 0; i < maxOut; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = this.inBuf[idx] ?? 0;
      const s1 = this.inBuf[idx + 1] ?? s0;
      out[i] = s0 + (s1 - s0) * frac;
      pos += this.ratio;
    }

    this.srcCursor = pos;

    // Drop consumed source to keep memory bounded
    const drop = Math.floor(this.srcCursor);
    if (drop > 0) {
      this.inBuf = this.inBuf.subarray(drop);
      this.srcCursor -= drop;
    }

    return out;
  }

  _floatToInt16Buffer(f32) {
    const out = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
      const s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;
    }
    return out.buffer; // ArrayBuffer (transferable)
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0] ? input[0] : null;
    if (!ch) return true;

    // Append latest mic samples
    const merged = new Float32Array(this.inBuf.length + ch.length);
    merged.set(this.inBuf, 0);
    merged.set(ch, this.inBuf.length);
    this.inBuf = merged;

    // Resample whatever we can to 16k
    const resampled = this._resampleAvailable();
    if (resampled.length) {
      // Combine with any leftover to form frames of 320 samples (20ms @ 16k)
      const comb = new Float32Array(this.hold.length + resampled.length);
      comb.set(this.hold, 0);
      comb.set(resampled, this.hold.length);

      const FRAME_SAMPLES = 320;
      const fullFrames = Math.floor(comb.length / FRAME_SAMPLES);
      const toSend = fullFrames * FRAME_SAMPLES;

      if (toSend > 0) {
        const payload = comb.subarray(0, toSend);     // Float32
        const int16buf = this._floatToInt16Buffer(payload);
        // Transfer the ArrayBuffer to main thread (zero-copy)
        this.port.postMessage(int16buf, [int16buf]);
      }

      // Keep remainder for next call
      this.hold = comb.subarray(toSend);
    }

    return true; // keep alive
  }
}

registerProcessor("pcm-processor", PCMProcessor);
