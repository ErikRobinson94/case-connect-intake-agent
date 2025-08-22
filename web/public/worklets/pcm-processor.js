// AudioWorkletProcessor that:
// - reads mic float32 frames at the AudioContext sampleRate
// - resamples to 16 kHz mono
// - packs into PCM16 20ms frames (320 samples = 640 bytes)
// - posts ArrayBuffers to the main thread
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inRate = sampleRate;       // AudioContext rate (e.g., 48k)
    this.outRate = 16000;           // Deepgram expects 16k for the web demo
    this.ratio = this.inRate / this.outRate;
    this.inBuf = [];                // JS array of floats (append-only, then slice)
    this.pos = 0;                   // fractional read position into inBuf
    this.outFloat = [];             // floats after resample, before framing
  }

  _resampleBlock(input) {
    // Append input floats
    for (let i = 0; i < input.length; i++) this.inBuf.push(input[i]);

    // Produce as many 16k samples as we can using linear interpolation
    const out = [];
    while (this.pos + 1 < this.inBuf.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const s0 = this.inBuf[i];
      const s1 = this.inBuf[i + 1];
      out.push(s0 + (s1 - s0) * frac);
      this.pos += this.ratio;
    }

    // Drop fully-consumed input samples
    const consumed = Math.floor(this.pos);
    if (consumed > 0) {
      this.inBuf = this.inBuf.slice(consumed);
      this.pos -= consumed;
    }
    return out;
  }

  _flushFrames() {
    // Frame size: 20ms @16k = 320 samples
    const FRAME_SAMPLES = 320;
    while (this.outFloat.length >= FRAME_SAMPLES) {
      const frame = this.outFloat.splice(0, FRAME_SAMPLES);
      const pcm16 = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        let v = frame[i];
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        pcm16[i] = (v < 0 ? v * 0x8000 : v * 0x7fff) | 0;
      }
      // Transfer the underlying buffer to main thread (zero-copy)
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
  }

  process(inputs, outputs) {
    // We only need the first input channel (mono)
    const input = inputs[0];
    if (input && input[0] && input[0].length) {
      const inBlock = input[0];
      const outBlock = this._resampleBlock(inBlock);
      if (outBlock.length) {
        // append to outFloat buffer
        for (let i = 0; i < outBlock.length; i++) this.outFloat.push(outBlock[i]);
        this._flushFrames();
      }
    }
    // We don’t output audio; keep the node silent in the graph
    if (outputs && outputs[0] && outputs[0][0]) {
      outputs[0][0].fill(0);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
