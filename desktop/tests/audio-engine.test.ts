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
  connect(target: GraphNode) { return target; }
  disconnect() {}
}
let contexts: FakeContext[] = [];
let nodes: FakeWorklet[] = [];
let moduleReady: () => Promise<void>;
class FakeContext {
  state = 'suspended';
  destination = new GraphNode();
  sink = new GraphNode();
  audioWorklet = { addModule: () => moduleReady() };
  constructor() { contexts.push(this); }
  createMediaStreamSource() { return new GraphNode(); }
  createGain() { return this.sink; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}
class FakeWorklet extends GraphNode {
  onprocessorerror: (() => void) | null = null;
  port: { onmessage: ((event: { data: unknown }) => void) | null; close: () => void } = { onmessage: null, close() {} };
  constructor() { super(); nodes.push(this); }
  measure(rms: number) { this.port.onmessage?.({ data: { rms, frames: 1600, sampleRate: 48000 } }); }
}
const originals = new Map<string, PropertyDescriptor | undefined>();
function global(name: string, value: unknown) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
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
