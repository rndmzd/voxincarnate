import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { ArticulationTracker, headAudioViseme, HEAD_AUDIO_VISEMES } from '../audio/articulation';
import { EnvelopeDetector } from '../audio/detector';
import { DEFAULT_DETECTOR } from '../shared';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['desktop/audio/headaudio.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: [{ name: 'asset-url', setup(builder) {
    builder.onResolve({ filter: /\?url&no-inline$/ }, () => ({ path: 'asset', namespace: 'test-url' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-url' }, () => ({ contents: 'export default "local-asset"' }));
  } }]
});
const { decodeHeadAudioModel } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as typeof import('../audio/headaudio');

describe('Canonical 2D articulation', () => {
  it('maps every Oculus ID explicitly, including ID zero and speech lip closure', () => {
    assert.deepEqual(HEAD_AUDIO_VISEMES, ['D', 'C', 'B', 'E', 'F', 'A', 'B', 'B', 'B', 'G', 'B', 'H', 'E', 'B', 'X']);
    assert.equal(headAudioViseme(0), 'D'); assert.equal(headAudioViseme(5), 'A');
    for (const invalid of [-1, 15, 0.5, NaN, '0', null]) assert.equal(headAudioViseme(invalid), undefined);
  });

  it('returns finite normalized weights, closes on silence, and expires stale predictions', () => {
    const tracker = new ArticulationTracker();
    assert.equal(tracker.receive({ event: 'viseme', viseme: 0, t: 0.016 }, 0), true);
    const vowel = tracker.snapshot(100, 100);
    assert.ok(vowel.weights.D! > 0.95);
    assert.ok(Math.abs(Object.values(vowel.weights).reduce((a, b) => a + b, 0) - 1) < 1e-8);
    tracker.receive({ event: 'ended', t: 0.12 }, 120);
    assert.ok(tracker.snapshot(220, 220).weights.X! > 0.89);
    tracker.receive({ event: 'viseme', viseme: 4, t: 0.25 }, 250);
    assert.ok(tracker.snapshot(350, 350).weights.F! > 0.95);
    assert.ok(tracker.snapshot(700, 700).weights.X! > 0.99);
  });

  it('rejects malformed messages and resets the audio cursor and old mouth immediately', () => {
    const tracker = new ArticulationTracker();
    for (const message of [null, {}, { event: 'viseme', viseme: 15, t: 0 }, { event: 'viseme', viseme: 0, t: NaN }, { event: 'viseme', viseme: 0, t: -1 }, { event: 'viseme', viseme: 0, t: 1e308 }]) {
      assert.equal(tracker.receive(message, 0), false);
    }
    tracker.receive({ event: 'viseme', viseme: 0, t: 0.016 }, 0);
    assert.equal(tracker.snapshot(100, 100).audioTimeMs, 16);
    assert.equal(tracker.snapshot(90, 110).audioTimeMs, 16);
    assert.equal(tracker.receive({ event: 'viseme', viseme: 5, t: 0.01 }, 120), false);
    assert.equal(tracker.snapshot(120, 120).audioTimeMs, 16);
    assert.deepEqual(tracker.reset(), { weights: { X: 1 }, audioTimeMs: 0 });
  });
});

describe('Pinned HeadAudio assets', () => {
  it('retains the unmodified vendored worklet, model and MIT license bytes', async () => {
    const hashes = {
      'headworklet.min.mjs': '37ebeb1d4d7e41fca7d12bb8fb411f7ce6bb21a2589602dec18e0a48b343be55',
      'model-en-mixed.bin': '0358f68989b5861f9b7d18871b010fa6cbf88a53bda4954a954d8c548bbcf251',
      LICENSE: 'd45d4192f4e7502846c6b01d743eddbff20b3752e4c350a88418f59e4587a60f'
    };
    for (const [file, hash] of Object.entries(hashes)) {
      const bytes = await readFile(`desktop/vendor/headaudio/${file}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
    }
  });

  it('loads all pretrained prototypes and rejects truncated or invalid model records', async () => {
    const bytes = await readFile('desktop/vendor/headaudio/model-en-mixed.bin');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const model = decodeHeadAudioModel(buffer);
    assert.equal(model.length, 39);
    assert.ok(model.some(record => record.viseme === 0));
    assert.ok(model.some(record => record.viseme === 14));
    assert.throws(() => decodeHeadAudioModel(buffer.slice(0, buffer.byteLength - 1)), /incomplete/);
    const corrupt = buffer.slice(0); new Uint8Array(corrupt)[7] = 255;
    assert.throws(() => decodeHeadAudioModel(corrupt), /invalid data/);
    const nonfinite = buffer.slice(0); new Float32Array(nonfinite, 8, 1)[0] = NaN;
    assert.throws(() => decodeHeadAudioModel(nonfinite), /invalid data/);
  });

  it('executes the vendored classifier on raw and gain-recovered quiet audio without posting samples', async () => {
    const messages: Array<{ event: string; viseme?: number; t?: number }> = [];
    type Worklet = {
      port: { onmessage: (event: { data: unknown }) => void };
      process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
    };
    let Constructor!: {
      new (options: unknown): Worklet;
      parameterDescriptors: Array<{ name: string; defaultValue: number }>;
    };
    class Base { port = { onmessage: null, postMessage: (data: typeof messages[number]) => messages.push(data) }; }
    const source = await readFile('desktop/vendor/headaudio/headworklet.min.mjs', 'utf8');
    // Remove only the module export for the isolated worklet-global test harness.
    runInNewContext(source.replace(/export\{HeadWorklet\};\s*$/, ''), {
      AudioWorkletProcessor: Base, sampleRate: 48000,
      registerProcessor: (_name: string, value: typeof Constructor) => { Constructor = value; }
    });
    const parameters = Object.fromEntries(Constructor.parameterDescriptors.map(({ name, defaultValue }) => [name, new Float32Array([defaultValue])]));
    parameters.silMode[0] = 0;
    const worklet = new Constructor({ processorOptions: {}, parameterData: { silMode: 0 } });
    const bytes = await readFile('desktop/vendor/headaudio/model-en-mixed.bin');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    worklet.port.onmessage({ data: { event: 'model', model: decodeHeadAudioModel(buffer) } });
    for (let frame = 0; frame < 200; frame++) {
      const audio = Float32Array.from({ length: 128 }, (_, i) => {
        const t = (frame * 128 + i) / 48000;
        return frame < 100 ? 0.2 * Math.sin(2 * Math.PI * 180 * t) + 0.1 * Math.sin(2 * Math.PI * 720 * t) : 0;
      });
      assert.equal(worklet.process([[audio]], [], parameters), true);
    }
    const visemes = messages.filter(message => message.event === 'viseme');
    assert.ok(visemes.length > 0, 'The real bundled model should classify the synthetic voiced signal.');
    assert.ok(visemes.every(message => Number.isInteger(message.viseme) && message.viseme! >= 0 && message.viseme! < 15 && Number.isFinite(message.t)));
    assert.ok(messages.some(message => message.event === 'ended'));
    assert.ok(messages.every(message => !('frame' in message) && !('vector' in message)));

    const classifyQuiet = (gain: number, vadMode: number) => {
      messages.length = 0;
      const quietParameters = { ...parameters, vadMode: new Float32Array([vadMode]) };
      const quiet = new Constructor({ processorOptions: {}, parameterData: { silMode: 0, vadMode } });
      quiet.port.onmessage({ data: { event: 'model', model: decodeHeadAudioModel(buffer) } });
      for (let frame = 0; frame < 150; frame++) {
        const audio = Float32Array.from({ length: 128 }, (_, i) => {
          const t = (frame * 128 + i) / 48000;
          return gain * (0.0005 * Math.sin(2 * Math.PI * 180 * t) + 0.00025 * Math.sin(2 * Math.PI * 720 * t));
        });
        quiet.process([[audio]], [], quietParameters);
      }
      return messages.filter(message => message.event === 'viseme').length;
    };
    assert.equal(classifyQuiet(1, 1), 0, 'The former fixed HeadAudio VAD blocks this quiet source.');
    const detector = new EnvelopeDetector({ ...DEFAULT_DETECTOR, gain: 16, openThresholdDb: -50, closeThresholdDb: -55, attackMs: 0 });
    assert.equal(detector.processRms(0.0005, 100).speaking, true);
    assert.ok(classifyQuiet(16, 0) > 0, 'With matching gain and no second VAD, the real model receives and classifies quiet speech-like input.');
  });
});
