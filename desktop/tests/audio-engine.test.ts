import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { DEFAULT_DETECTOR } from '../shared';

// Bundle the production engine, replacing only Vite's asset URL resolution.
// Browser APIs below are test doubles; capture/device behavior still needs a real smoke test.
const bundle = await build({
  entryPoints: ['desktop/audio/engine.ts'], bundle: true, write: false, format: 'esm', platform: 'browser',
  plugins: [{ name: 'worklet-url', setup(builder) {
    builder.onResolve({ filter: /\?url&no-inline$/ }, () => ({ path: 'worklet', namespace: 'test-url' }));
    builder.onLoad({ filter: /.*/, namespace: 'test-url' }, () => ({ contents: 'export default "test-worklet.js"' }));
  } }]
});
const { AudioEngine } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`) as typeof import('../audio/engine');

class Track extends EventTarget {
  readyState = 'live';
  stops = 0;
  stop() { this.stops++; this.readyState = 'ended'; }
}
const media = (track: Track) => ({ getTracks: () => [track], getAudioTracks: () => [track] }) as unknown as MediaStream;
class GraphNode {
  gain = { value: 1 };
  connections: GraphNode[] = [];
  connect(target: GraphNode) { this.connections.push(target); return target; }
  disconnect(target?: GraphNode) { this.connections = target ? this.connections.filter(node => node !== target) : []; }
}
let contexts: FakeContext[] = [];
let nodes: FakeWorklet[] = [];
let moduleReady: (url: string) => Promise<void>;
const modelFile = await readFile('desktop/vendor/headaudio/model-en-mixed.bin');
const modelBuffer = () => modelFile.buffer.slice(modelFile.byteOffset, modelFile.byteOffset + modelFile.byteLength);
class FakeContext {
  state = 'suspended';
  destination = new GraphNode();
  gains: GraphNode[] = [];
  get sink() { return this.gains[0]; }
  source = new GraphNode();
  audioWorklet = { addModule: (url: string) => moduleReady(url) };
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return this.source; }
  createGain() { const gain = new GraphNode(); this.gains.push(gain); return gain; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class FakeWorklet extends GraphNode {
  onprocessorerror: (() => void) | null = null;
  messages: unknown[] = [];
  port: { onmessage: ((event: { data: unknown }) => void) | null; close: () => void; postMessage: (message: unknown) => void } = {
    onmessage: null, close() {}, postMessage: message => { this.messages.push(message); }
  };
  constructor(_context: unknown, public name: string, public options: AudioWorkletNodeOptions) { super(); nodes.push(this); }
  measure(rms: number) { this.port.onmessage?.({ data: { rms, frames: 1600, sampleRate: 48000 } }); }
  event(data: unknown) { this.port.onmessage?.({ data }); }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown) {
  if (!originals.has(name)) originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}
async function settle() { await new Promise<void>(resolve => setImmediate(resolve)); }

describe('AudioEngine capture lifecycle', { concurrency: false }, () => {
  let track: Track;
  let engine: InstanceType<typeof AudioEngine>;
  beforeEach(() => {
    contexts = []; nodes = []; track = new Track(); moduleReady = async () => undefined;
    global('navigator', { mediaDevices: { getUserMedia: async () => media(track), getDisplayMedia: async () => media(track) } });
    global('AudioContext', FakeContext); global('AudioWorkletNode', FakeWorklet);
    global('fetch', async () => ({ ok: true, arrayBuffer: async () => modelBuffer() }));
    engine = new AudioEngine(DEFAULT_DETECTOR);
  });
  afterEach(async () => {
    await engine.stop();
    mock.restoreAll(); mock.timers.reset();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    originals.clear();
  });

  it('rejects a canceled permission request and closes its late-arriving stream', async () => {
    let deliver!: (stream: MediaStream) => void;
    navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { deliver = resolve; });
    const starting = engine.startDirect('mic', () => {}, () => {});
    await settle();
    await engine.stop(); deliver(media(track));
    await assert.rejects(starting, { name: 'AbortError' });
    assert.equal(track.stops, 1); assert.equal(contexts.length, 0);
  });

  it('rejects cancellation during worklet loading rather than reporting successful startup', async () => {
    let deliver!: () => void;
    moduleReady = () => new Promise(resolve => { deliver = resolve; });
    const starting = engine.startDirect('mic', () => {}, () => {});
    await settle();
    await engine.stop(); deliver();
    await assert.rejects(starting, { name: 'AbortError' });
    assert.equal(contexts[0].state, 'closed'); assert.equal(track.stops, 1);
    assert.equal(nodes.length, 0);
  });

  it('forces final silence and ends once when a live source disappears', async () => {
    const states: Array<{ level: number; speaking: boolean }> = [];
    const ended: string[] = [];
    await engine.startDirect('mic', state => states.push(state), reason => ended.push(reason));
    nodes[0].measure(0.2);
    assert.equal(states.at(-1)?.speaking, true);
    track.dispatchEvent(new Event('ended'));
    track.dispatchEvent(new Event('ended'));
    await settle();
    assert.equal(ended.length, 1);
    assert.equal(states.at(-1)?.level, 0); assert.equal(states.at(-1)?.speaking, false);
    assert.equal(contexts[0].state, 'closed'); assert.equal(track.stops, 1);
    assert.equal(contexts[0].sink.gain.value, 0);
  });

  it('closes a stalled graph after one second without worklet measurements', async () => {
    let clock = 0;
    mock.method(performance, 'now', () => clock);
    mock.timers.enable({ apis: ['setInterval'] });
    const states: Array<{ level: number; speaking: boolean }> = [];
    const ended: string[] = [];
    await engine.startBrowser(state => states.push(state), reason => ended.push(reason));
    nodes[0].measure(0.2);
    clock = 900; mock.timers.tick(250);
    assert.equal(ended.length, 0);
    clock = 1001; mock.timers.tick(250);
    await settle();
    assert.match(ended[0], /stopped delivering data/);
    assert.equal(states.at(-1)?.level, 0); assert.equal(states.at(-1)?.speaking, false);
    assert.equal(contexts[0].state, 'closed'); assert.equal(track.stops, 1);
  });

  it('analyzes the raw source in a zero-output viseme branch without replaying captured audio', async () => {
    await engine.startBrowser(() => {}, () => {});
    const [rms, lips] = nodes;
    assert.equal(rms.name, 'vox-rms'); assert.equal(lips.name, 'headworklet');
    assert.equal(lips.options.numberOfOutputs, 0);
    assert.equal(lips.options.channelCount, 1);
    assert.deepEqual(contexts[0].source.connections, [rms, contexts[0].gains[1]]);
    assert.deepEqual(contexts[0].gains[1].connections, [lips]);
    assert.deepEqual(lips.connections, []);
    assert.equal(contexts[0].sink.gain.value, 0);
    const imported = lips.messages[0] as { event: string; model: unknown[] };
    assert.equal(imported.event, 'model'); assert.equal(imported.model.length, 39);
    assert.equal(lips.options.parameterData?.vadMode, 0);
  });

  it('publishes AA and P/B/M closures at the same speech energy, in increasing audio time', async () => {
    const states: Array<import('../audio/engine').AudioEngineState> = [];
    await engine.startBrowser(state => states.push(state), () => {});
    const [rms, lips] = nodes;
    lips.event({ event: 'viseme', viseme: 0, t: 0.016 });
    for (let i = 0; i < 4; i++) rms.measure(0.2);
    const vowel = states.at(-1)!;
    assert.equal(vowel.speaking, true);
    assert.ok(vowel.articulation!.weights.D! > 0.9);
    lips.event({ event: 'viseme', viseme: 5, t: 0.128 });
    for (let i = 0; i < 3; i++) rms.measure(0.2);
    const closure = states.at(-1)!;
    assert.equal(closure.speaking, true);
    assert.ok(closure.articulation!.weights.A! > 0.99);
    assert.ok(closure.articulation!.audioTimeMs > vowel.articulation!.audioTimeMs);
  });

  for (const mode of ['direct', 'browser'] as const) {
    it(`returns ${mode} capture to rest below the visible threshold despite ongoing mouth predictions`, async () => {
      const detector = { ...DEFAULT_DETECTOR, openThresholdDb: -38, closeThresholdDb: -45, holdMs: 60, attackMs: 0, releaseMs: 0 };
      engine.setSettings(detector);
      const states: Array<import('../audio/engine').AudioEngineState> = [];
      const ended: string[] = [];
      const publish = (state: import('../audio/engine').AudioEngineState) => states.push(state);
      const end = (reason: string) => ended.push(reason);
      if (mode === 'direct') await engine.startDirect('mic', publish, end);
      else await engine.startBrowser(publish, end);
      const [rms, lips] = nodes;
      let block = 0;
      const measure = (db: number) => {
        // Keep sending fresh open-mouth predictions: only the configured energy
        // threshold and hold should decide whether capture is speaking or idle.
        lips.event({ event: 'viseme', viseme: 0, t: ++block / 30 });
        rms.measure(10 ** (db / 20));
        return states.at(-1)!;
      };
      for (let i = 0; i < 4; i++) measure(-30);
      assert.equal(states.at(-1)!.speaking, true);
      assert.ok(states.at(-1)!.articulation!.weights.D! > 0.9);
      assert.equal(measure(-42).speaking, true, 'The first 33 ms block still falls within the 60 ms mouth hold.');
      let idle = measure(-42);
      assert.equal(idle.speaking, false, 'Nonzero background noise below -38 dB must close the mouth after the hold.');
      assert.ok(Math.abs(idle.db - -42) < 1e-6);
      assert.deepEqual(idle.articulation!.weights, { X: 1 });
      for (let i = 0; i < 3; i++) idle = measure(-42);
      assert.equal(idle.speaking, false);
      assert.deepEqual(idle.articulation!.weights, { X: 1 });

      assert.equal(measure(-36).speaking, true, 'New speech above the visible threshold reopens the mouth.');
      assert.ok(measure(-36).articulation!.weights.D! > 0.8);
      engine.setSettings({ ...detector, openThresholdDb: -34, closeThresholdDb: -41 });
      assert.equal(measure(-36).speaking, true);
      idle = measure(-36);
      assert.equal(idle.speaking, false, 'A live threshold change also closes after the configured hold.');
      assert.deepEqual(idle.articulation!.weights, { X: 1 });
      assert.deepEqual(ended, []);
      assert.equal(track.readyState, 'live');
      assert.equal(contexts[0].state, 'running');
      assert.equal(contexts.length, 1, 'Returning to idle does not restart capture.');
    });
  }

  it('clears articulation on stop and ignores queued old-generation viseme messages', async () => {
    const states: Array<import('../audio/engine').AudioEngineState> = [];
    await engine.startDirect('mic', state => states.push(state), () => {});
    const [rms, lips] = nodes;
    const delayedMessage = lips.port.onmessage!;
    lips.event({ event: 'viseme', viseme: 0, t: 0.016 }); rms.measure(0.2);
    await engine.stop();
    assert.deepEqual(states.at(-1)!.articulation, { weights: { X: 1 }, audioTimeMs: 0 });
    const count = states.length;
    delayedMessage({ data: { event: 'viseme', viseme: 0, t: 0.048 } }); rms.measure(0.2);
    assert.equal(states.length, count);
    assert.equal(lips.port.onmessage, null);
  });

  it('falls back visibly when the local model cannot load, while retaining binary audio detection', async () => {
    global('fetch', async () => { throw new Error('Missing local model asset'); });
    const states: Array<import('../audio/engine').AudioEngineState> = [];
    await engine.startDirect('mic', state => states.push(state), () => {});
    nodes[0].measure(0.2);
    assert.match(states.at(-1)!.lipSyncError!, /open\/closed.*Missing local model asset/);
    assert.equal(states.at(-1)!.speaking, true);
    assert.equal(states.at(-1)!.articulation, undefined);
  });

  it('falls back visibly on a viseme processor error without ending healthy capture', async () => {
    const states: Array<import('../audio/engine').AudioEngineState> = [];
    const ended: string[] = [];
    await engine.startDirect('mic', state => states.push(state), reason => ended.push(reason));
    nodes[1].onprocessorerror!(); nodes[0].measure(0.2);
    assert.match(states.at(-1)!.lipSyncError!, /local lip-sync processor stopped/);
    assert.equal(states.at(-1)!.articulation, undefined);
    assert.equal(states.at(-1)!.speaking, true);
    assert.equal(ended.length, 0);
    assert.equal(contexts[0].state, 'running');
  });

  it('cancels pending model loading and never connects a late analyzer to a stopped source', async () => {
    let deliver!: (value: unknown) => void;
    global('fetch', () => new Promise(resolve => { deliver = resolve; }));
    const states: Array<import('../audio/engine').AudioEngineState> = [];
    const starting = engine.startDirect('mic', state => states.push(state), () => {});
    await settle();
    await engine.stop();
    deliver({ ok: true, arrayBuffer: async () => modelBuffer() });
    await assert.rejects(starting, { name: 'AbortError' });
    assert.deepEqual(contexts[0].source.connections, []);
    assert.equal(nodes.length, 1);
    assert.deepEqual(states.at(-1)!.articulation, { weights: { X: 1 }, audioTimeMs: 0 });
  });

  it('uses configured gain and the existing thresholds for quiet articulation, updating live', async () => {
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: 16, openThresholdDb: -50, closeThresholdDb: -55, attackMs: 0, releaseMs: 0, holdMs: 0 });
    const states: Array<import('../audio/engine').AudioEngineState> = [];
    await engine.startDirect('mic', state => states.push(state), () => {});
    const [rms, lips] = nodes;
    assert.equal(contexts[0].gains[1].gain.value, 16);
    lips.event({ event: 'viseme', viseme: 0, t: 0.016 });
    for (let i = 0; i < 4; i++) rms.measure(0.0005);
    assert.equal(states.at(-1)!.speaking, true);
    assert.ok(states.at(-1)!.articulation!.weights.D! > 0.9);
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: 1, openThresholdDb: -30, closeThresholdDb: -35, attackMs: 0, releaseMs: 0, holdMs: 0 });
    assert.equal(contexts[0].gains[1].gain.value, 1);
    const oldClock = states.at(-1)!.articulation!.audioTimeMs;
    rms.measure(0.0005);
    assert.equal(states.at(-1)!.speaking, false);
    assert.deepEqual(states.at(-1)!.articulation, { weights: { X: 1 }, audioTimeMs: oldClock });
    assert.equal(contexts[0].sink.gain.value, 0);
  });

  it('uses the latest settings after pending model loading and bounds live inference gain', async () => {
    let deliver!: (value: unknown) => void;
    global('fetch', () => new Promise(resolve => { deliver = resolve; }));
    const starting = engine.startDirect('mic', () => {}, () => {});
    await settle();
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: 8 });
    deliver({ ok: true, arrayBuffer: async () => modelBuffer() });
    await starting;
    const gain = contexts[0].gains[1];
    assert.equal(gain.gain.value, 8);
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: Infinity }); assert.equal(gain.gain.value, 1);
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: 100 }); assert.equal(gain.gain.value, 32);
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: -1 }); assert.equal(gain.gain.value, 0);
    await engine.stop();
    engine.setSettings({ ...DEFAULT_DETECTOR, gain: 16 });
    assert.equal(gain.gain.value, 0, 'Stopped inference nodes must not receive later setting changes.');
    assert.deepEqual(gain.connections, []);
  });
});

describe('AudioWorklet measurement boundary', () => {
  async function processor() {
    const messages: Array<{ rms: number; frames: number; sampleRate: number }> = [];
    let Constructor!: new () => { process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean };
    class Base { port = { postMessage: (message: typeof messages[number]) => messages.push(message) }; }
    runInNewContext(await readFile('desktop/audio/rms-worklet.js', 'utf8'), {
      AudioWorkletProcessor: Base, sampleRate: 48000,
      registerProcessor: (_name: string, value: typeof Constructor) => { Constructor = value; }
    });
    return { worklet: new Constructor(), messages };
  }

  it('emits only scalar energy for phase-inverted stereo and keeps its output silent', async () => {
    const { worklet, messages } = await processor();
    const input = [new Float32Array(128).fill(0.1), new Float32Array(128).fill(-0.1)];
    const output = new Float32Array(128).fill(1);
    for (let i = 0; i < 8; i++) worklet.process([input], [[output]]);
    assert.ok(Math.abs(messages[0].rms - 0.1) < 1e-6);
    assert.equal(messages[0].frames, 1024);
    assert.equal(Object.keys(messages[0]).sort().join(','), 'frames,rms,sampleRate');
    assert.ok(output.every(sample => sample === 0));
  });

  it('continues finite silence measurements when an idle tab has no active input channels', async () => {
    const { worklet, messages } = await processor();
    for (let i = 0; i < 8; i++) worklet.process([[]], [[new Float32Array(128)]]);
    assert.equal(messages.length, 1); assert.equal(messages[0].rms, 0);
    assert.equal(messages[0].frames, 1024);
  });
});
