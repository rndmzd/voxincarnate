import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EnvelopeDetector } from '../audio/detector';
import { DEFAULT_DETECTOR, type DetectorSettings } from '../shared';

const settings = (overrides: Partial<DetectorSettings> = {}): DetectorSettings => ({
  ...DEFAULT_DETECTOR, attackMs: 0, releaseMs: 0, ...overrides
});
const block = (value: number, length = 480) => new Float32Array(length).fill(value);
const closeTo = (actual: number, expected: number, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} differs from ${expected}`);

describe('EnvelopeDetector', () => {
  it('measures stereo energy without cancelling phase-inverted channels', () => {
    const detector = new EnvelopeDetector(settings());
    const result = detector.process([block(0.1), block(-0.1)], 48000);
    closeTo(result.level, 0.1);
    closeTo(result.db, -20, 1e-5);
    assert.equal(result.speaking, true);
  });

  it('keeps low background noise closed rather than normalizing it to full scale', () => {
    const detector = new EnvelopeDetector(settings());
    for (const value of [0.0001, 0.0008, 0.0002, 0.001]) {
      assert.equal(detector.process([block(value)], 48000).speaking, false);
    }
    assert.ok(detector.process([block(0.0008)], 48000).level < 0.002);
  });

  it('uses hysteresis and a hold before closing, with new speech resetting the hold', () => {
    const detector = new EnvelopeDetector(settings({ openThresholdDb: -30, closeThresholdDb: -40, holdMs: 30 }));
    assert.equal(detector.processRms(0.02, 10).speaking, false); // -34 dB cannot open.
    assert.equal(detector.processRms(0.1, 10).speaking, true);
    assert.equal(detector.processRms(0.02, 10).speaking, true); // Hysteresis keeps it open.
    assert.equal(detector.processRms(0, 20).speaking, true);
    assert.equal(detector.processRms(0.02, 10).speaking, true); // Clears quiet timer.
    assert.equal(detector.processRms(0, 20).speaking, true);
    assert.equal(detector.processRms(0, 10).speaking, false);
  });

  it('calculates attack and release from elapsed sample duration, independent of block size', () => {
    const small = new EnvelopeDetector(settings({ attackMs: 50, releaseMs: 100 }));
    const large = new EnvelopeDetector(settings({ attackMs: 50, releaseMs: 100 }));
    let state = small.process([block(0.2)], 48000);
    for (let i = 1; i < 10; i++) state = small.process([block(0.2)], 48000);
    closeTo(state.level, large.process([block(0.2, 4800)], 48000).level, 1e-10);
    for (let i = 0; i < 10; i++) state = small.process([block(0)], 48000);
    closeTo(state.level, large.process([block(0, 4800)], 48000).level, 1e-10);
  });

  it('applies gain, sanitizes invalid samples/settings, and bounds clipped input', () => {
    const detector = new EnvelopeDetector(settings({ gain: 2 }));
    closeTo(detector.process([block(0.1)], 48000).level, 0.2);
    assert.deepEqual(detector.process([new Float32Array([NaN, Infinity, -Infinity, 0])], 48000), { level: 0, db: -120, speaking: true });
    const clipped = detector.process([block(-32768)], 48000);
    assert.equal(clipped.level, 1);
    assert.equal(clipped.db, 0);
    detector.update(settings({ gain: NaN, openThresholdDb: Infinity, attackMs: NaN }));
    const result = detector.process([block(0.05)], NaN);
    assert.ok(Number.isFinite(result.level) && Number.isFinite(result.db));
  });

  it('returns to final silence and clears state immediately on reset', () => {
    const detector = new EnvelopeDetector(DEFAULT_DETECTOR);
    detector.processRms(0.2, 100);
    let state = detector.processRms(0, 20);
    for (let i = 0; i < 100; i++) state = detector.processRms(0, 20);
    assert.deepEqual(state, { level: 0, db: -120, speaking: false });
    detector.processRms(0.2, 100);
    assert.deepEqual(detector.reset(), { level: 0, db: -120, speaking: false });
    assert.deepEqual(detector.process([], 48000), { level: 0, db: -120, speaking: false });
  });
});
