/* Runs on Chromium's audio thread. No logging, IPC, or PCM copies. */
class RmsProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.energy = 0;
    this.samples = 0;
    this.frames = 0;
  }

  process(inputs, outputs) {
    // Keep the graph active without monitoring the mic or replaying browser audio.
    for (const output of outputs) for (const channel of output) channel.fill(0);
    const channels = inputs[0];
    const frames = channels?.[0]?.length || outputs[0]?.[0]?.length || 128;
    this.frames += frames;
    if (channels?.length) {
      const before = this.samples;
      for (const channel of channels) {
        for (let i = 0; i < channel.length; i++) {
          const value = Number.isFinite(channel[i]) ? channel[i] : 0;
          this.energy += value * value;
        }
        this.samples += channel.length;
      }
      if (this.samples === before) this.samples += frames;
    } else this.samples += frames; // A healthy but idle tab still produces silence.
    if (this.frames >= sampleRate / 50) {
      this.port.postMessage({ rms: Math.sqrt(this.energy / this.samples), frames: this.frames, sampleRate });
      this.energy = 0;
      this.samples = 0;
      this.frames = 0;
    }
    return true;
  }
}
registerProcessor('vox-rms', RmsProcessor);
