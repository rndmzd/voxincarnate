import type { Articulation, Viseme, VisemeWeights } from '../shared';

/** HeadAudio's Oculus IDs, explicitly reduced to the authored 2D A–H/X set. */
export const HEAD_AUDIO_VISEMES: readonly Viseme[] = [
  'D', // aa: wide open
  'C', // E: medium open
  'B', // I: narrow / teeth
  'E', // O: rounded
  'F', // U: puckered
  'A', // PP: P/B/M lip closure, even while the energy gate remains open
  'B', // SS: teeth
  'B', // TH: tongue/teeth approximated by the narrow mouth
  'B', // DD: most consonants
  'G', // FF: upper teeth against lower lip
  'B', // kk: most consonants
  'H', // nn: tongue raised
  'E', // RR: slightly rounded
  'B', // CH: teeth
  'X'  // sil: relaxed rest
];

export function headAudioViseme(id: unknown): Viseme | undefined {
  return typeof id === 'number' && Number.isInteger(id) ? HEAD_AUDIO_VISEMES[id] : undefined;
}

/** Smooths classifier targets in audio time; speech gating never chooses the mouth. */
export class ArticulationTracker {
  private weights: VisemeWeights = { X: 1 };
  private target: Viseme = 'X';
  private lastMessageMs = -Infinity;
  private lastAudioTimeMs = 0;
  private predictionAudioTimeMs = 0;

  receive(message: unknown, nowMs: number): boolean {
    if (!message || typeof message !== 'object') return false;
    const data = message as { event?: unknown; viseme?: unknown; t?: unknown };
    if (typeof data.t !== 'number' || !Number.isFinite(data.t) || data.t < 0) return false;
    const target = data.event === 'ended' ? 'X' : data.event === 'viseme' ? headAudioViseme(data.viseme) : undefined;
    if (!target) return false;
    const acquisitionMs = data.t * 1000;
    if (!Number.isFinite(acquisitionMs) || acquisitionMs < this.predictionAudioTimeMs) return false;
    this.target = target;
    this.lastMessageMs = nowMs;
    this.predictionAudioTimeMs = acquisitionMs;
    return true;
  }

  snapshot(audioTimeMs: number, nowMs: number, active = true): Articulation {
    const cursor = Number.isFinite(audioTimeMs) ? Math.max(this.lastAudioTimeMs, audioTimeMs, 0) : this.lastAudioTimeMs;
    const durationMs = cursor - this.lastAudioTimeMs;
    this.lastAudioTimeMs = cursor;
    if (!active) {
      // The app's RMS threshold and hold are the sole activity gate. Keep its
      // silence decision immediate without resetting the acquisition clock.
      this.weights = { X: 1 };
      this.target = 'X';
      this.lastMessageMs = -Infinity;
      return { weights: { X: 1 }, audioTimeMs: this.predictionAudioTimeMs };
    }
    // An idle captured tab can stop supplying channels before an 'ended' event.
    if (nowMs - this.lastMessageMs > 250) this.target = 'X';
    // Closures need a prompt response, rather than inheriting the volume hold.
    const timeConstantMs = this.target === 'A' ? 18 : this.target === 'X' ? 45 : 32;
    const alpha = -Math.expm1(-durationMs / timeConstantMs);
    const next: VisemeWeights = {};
    let sum = 0;
    for (const pose of new Set(HEAD_AUDIO_VISEMES)) {
      const value = (this.weights[pose] || 0) + ((this.target === pose ? 1 : 0) - (this.weights[pose] || 0)) * alpha;
      if (value >= 0.001) { next[pose] = value; sum += value; }
    }
    if (sum > 0) for (const pose of Object.keys(next) as Viseme[]) next[pose]! /= sum;
    else next.X = 1;
    this.weights = next;
    // Keep the upstream acquisition timestamp when reusing a prediction; the
    // render/publication time must not make an older classification look new.
    return { weights: { ...next }, audioTimeMs: this.predictionAudioTimeMs };
  }

  reset(): Articulation {
    this.weights = { X: 1 };
    this.target = 'X';
    this.lastMessageMs = -Infinity;
    this.lastAudioTimeMs = 0;
    this.predictionAudioTimeMs = 0;
    return { weights: { X: 1 }, audioTimeMs: 0 };
  }
}
