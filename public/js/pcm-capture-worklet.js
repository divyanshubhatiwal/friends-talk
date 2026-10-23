/* Audio worklet: turns any input stream into 16 kHz 16-bit PCM in 100 ms
 * chunks, the format Gemini's Live API expects.
 *
 * Runs on the audio thread, so it does the minimum: a box-filter downsample
 * (good enough for speech, and it handles 44.1 kHz devices as well as 48 kHz)
 * and a level gate. Encoding to base64 and networking stay on the main thread.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.acc = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(1600); // 100 ms at 16 kHz
    this.n = 0;
    this.muted = false;
    // While the AI is talking, only loud input (the user deliberately cutting
    // in) passes; quieter sound is assumed to be its own voice coming back
    // through the speakers, which would otherwise make it interrupt itself.
    this.gate = 0;
    this.blockPeak = 0;
    this.port.onmessage = (event) => {
      if ('muted' in event.data) this.muted = event.data.muted;
      if ('gate' in event.data) this.gate = event.data.gate;
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let peak = 0;
    for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i]));
    const silent = this.muted || peak < this.gate;

    for (let i = 0; i < channel.length; i++) {
      this.sum += silent ? 0 : channel[i];
      this.count += 1;
      this.acc += 1;
      if (this.acc < this.ratio) continue;
      this.acc -= this.ratio;

      const v = Math.max(-1, Math.min(1, this.sum / this.count));
      this.sum = 0;
      this.count = 0;
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;

      if (this.n === this.out.length) {
        // Silence is still sent: the API's voice-activity detection needs it
        // to know a sentence has ended.
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(1600);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
