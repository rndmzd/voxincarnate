import type { DetectorSettings } from '../shared';

export interface EnvelopeState { level: number; db: number; speaking: boolean }

const FLOOR_DB = -120;
const finite = (value: number, fallback: number) => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Energy envelope and speech hold, independent of any audio device or browser API. */
export class EnvelopeDetector {
  private settings!: DetectorSettings;
  private level = 0;
  private speaking = false;
  private quietMs = 0;

  constructor(settings: DetectorSettings) { this.update(settings); }

  update(settings: DetectorSettings): void {
    const openThresholdDb = clamp(finite(settings.openThresholdDb, -38), -100, 0);
    this.settings = {
      gain: clamp(finite(settings.gain, 1), 0, 32),
      openThresholdDb,
      // Older libraries have a hidden, lower close threshold. The visible mouth
      // threshold now gates both directions; holdMs handles brief speech pauses.
      closeThresholdDb: openThresholdDb,
      attackMs: clamp(finite(settings.attackMs, 25), 0, 2000),
      releaseMs: clamp(finite(settings.releaseMs, 90), 0, 5000),
      holdMs: clamp(finite(settings.holdMs, 250), 0, 5000)
    };
  }

  process(channels: Float32Array[], sampleRate: number): EnvelopeState {
    let energy = 0;
    let samples = 0;
    let frames = 0;
    for (const channel of channels) {
      frames = Math.max(frames, channel.length);
      for (const sample of channel) {
        const value = Number.isFinite(sample) ? sample : 0;
        energy += value * value;
        samples++;
      }
    }
    if (!frames || !samples) return this.snapshot();
    const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 48000;
    // Average channel energies rather than waveforms: inverted stereo cannot cancel.
    return this.processRms(Math.sqrt(energy / samples), frames / rate * 1000);
  }

  /** Receives only scalar measurements from the AudioWorklet, never PCM. */
  processRms(rms: number, durationMs: number): EnvelopeState {
    const duration = clamp(finite(durationMs, 0), 0, 10000);
    if (!duration) return this.snapshot();
    const target = clamp(finite(rms, 0) * this.settings.gain, 0, 1);
    const timeConstant = target > this.level ? this.settings.attackMs : this.settings.releaseMs;
    const alpha = timeConstant > 0 ? -Math.expm1(-duration / timeConstant) : 1;
    this.level = clamp(this.level + (target - this.level) * alpha, 0, 1);
    // Snap numerical tails to silence; dB and level remain finite for all inputs.
    if (this.level < 1e-6) this.level = 0;
    const db = this.toDb();
    if (!this.speaking) {
      if (db >= this.settings.openThresholdDb) {
        this.speaking = true;
        this.quietMs = 0;
      }
    } else if (db >= this.settings.closeThresholdDb) {
      this.quietMs = 0;
    } else {
      this.quietMs += duration;
      if (this.quietMs >= this.settings.holdMs) {
        this.speaking = false;
        this.quietMs = 0;
      }
    }
    return this.snapshot();
  }

  reset(): EnvelopeState {
    this.level = 0;
    this.speaking = false;
    this.quietMs = 0;
    return this.snapshot();
  }

  private toDb(): number { return this.level > 0 ? Math.max(FLOOR_DB, 20 * Math.log10(this.level)) : FLOOR_DB; }
  private snapshot(): EnvelopeState { return { level: this.level, db: this.toDb(), speaking: this.speaking }; }
}
