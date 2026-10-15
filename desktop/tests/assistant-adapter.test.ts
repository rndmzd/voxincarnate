import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import type { AssistantAdapterCommand } from '../browser-adapter';

// Match the production build instead of tsx's keepNames instrumentation, whose
// __name helper intentionally lives outside every function.
const adapterSource = transformSync(readFileSync(new URL('../browser-adapter.ts', import.meta.url), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022', keepNames: false
}).code;
const adapter = vm.runInNewContext(`${adapterSource}\nmodule.exports;`, { module: { exports: {} } }) as {
  installAssistantAdapter: Function;
  sendAssistantAdapterCommand: Function;
};

class FakeTrack {
  readyState = 'live';
  stops = 0;
  constructor(readonly label: string, readonly deviceId: string) {}
  getSettings() { return { deviceId: this.deviceId }; }
  stop() { this.readyState = 'ended'; this.stops++; }
  addEventListener() {}
}

function fakeStream(id: string, label = id) {
  const audio = new FakeTrack(label, id);
  const video = new FakeTrack('camera', 'camera');
  return { audio, video, getTracks: () => [audio, video], getAudioTracks: () => [audio] };
}

function fixture(enabled = true, deviceId = 'origin-mic-one') {
  const reports: { devices?: { deviceId: string; label: string }[]; actualInput?: string; message?: string; error?: string }[] = [];
  const calls: (MediaStreamConstraints | undefined)[] = [];
  const streams: ReturnType<typeof fakeStream>[] = [];
  const listeners = new Map<string, () => void>();
  let devices = [{ kind: 'audioinput', deviceId: 'origin-mic-one', label: 'USB microphone' }];
  let handler = async (constraints?: MediaStreamConstraints) => {
    const audio = constraints?.audio as MediaTrackConstraints | undefined;
    const exact = typeof audio?.deviceId === 'object' && 'exact' in audio.deviceId ? audio.deviceId.exact : 'default';
    const stream = fakeStream(typeof exact === 'string' ? exact : 'default', 'USB microphone');
    streams.push(stream);
    return stream;
  };
  const media = {
    getUserMedia: async (constraints?: MediaStreamConstraints) => { calls.push(constraints); return handler(constraints); },
    enumerateDevices: async () => devices,
    addEventListener: (event: string, listener: () => void) => listeners.set(event, listener)
  };
  const window = { location: { origin: 'https://assistant.example' }, isSecureContext: true, postMessage: (data: { status: typeof reports[number] }) => reports.push(data.status) };
  const context = vm.createContext({ window, navigator: { mediaDevices: media }, DOMException, Error });
  // Executing the serialized function catches accidental dependencies on module
  // helpers that would disappear across Electron's isolated/main-world boundary.
  const installed = vm.runInContext(`(${adapter.installAssistantAdapter.toString()})`, context)({ enabled, deviceId, controllerKey: 'controller', diagnosticsKey: 'diagnostics' });
  const send = vm.runInContext(`(${adapter.sendAssistantAdapterCommand.toString()})`, context);
  return {
    media, calls, streams, reports, installed,
    command: (command: AssistantAdapterCommand) => send('controller', command),
    setHandler: (next: typeof handler) => { handler = next; },
    setDevices: (next: typeof devices) => { devices = next; },
    changed: () => listeners.get('devicechange')?.()
  };
}

const flush = async () => { await new Promise<void>(resolve => setImmediate(resolve)); };

test('installation reports readiness without opening a microphone', () => {
  const f = fixture(false);
  assert.equal(f.installed.ready, true);
  assert.match(f.reports.at(-1)?.message || '', /adapter ready/);
  assert.equal(f.reports.at(-1)?.error, '');
  assert.equal(f.calls.length, 0);
});

test('unavailable page media APIs report a diagnosable installation failure', () => {
  const reports: { error?: string }[] = [];
  const window = { location: { origin: 'https://assistant.example' }, isSecureContext: false,
    postMessage: (data: { status: typeof reports[number] }) => reports.push(data.status) };
  const context = vm.createContext({ window, navigator: {} });
  const installed = vm.runInContext(`(${adapter.installAssistantAdapter.toString()})`, context)({
    enabled: false, deviceId: '', controllerKey: 'controller', diagnosticsKey: 'diagnostics'
  });
  assert.equal(installed.ready, false);
  assert.match(installed.error, /secure context: no/);
  assert.equal(reports.at(-1)?.error, installed.error);
  const send = vm.runInContext(`(${adapter.sendAssistantAdapterCommand.toString()})`, context);
  assert.equal(send('controller', { type: 'devices' }), false);
});

test('document-start adapter blocks microphone capture until browser mode is enabled', async () => {
  const f = fixture(false);
  await assert.rejects(f.media.getUserMedia({ audio: true }), { name: 'NotAllowedError' });
  assert.equal(f.calls.length, 0);
  const video = { video: true, audio: false };
  await f.media.getUserMedia(video);
  assert.equal(f.calls[0], video);
});

test('selected origin device is exact, constraints survive, and actual track is verified', async () => {
  const f = fixture();
  await f.media.getUserMedia({ audio: { echoCancellation: false, sampleRate: 48000, deviceId: 'site-default' }, video: false });
  const sent = f.calls[0]!;
  assert.equal(sent.video, false);
  assert.equal((sent.audio as MediaTrackConstraints).echoCancellation, false);
  assert.equal((sent.audio as MediaTrackConstraints).sampleRate, 48000);
  assert.equal(JSON.stringify((sent.audio as MediaTrackConstraints).deviceId), JSON.stringify({ exact: 'origin-mic-one' }));
  assert.equal(f.reports.at(-1)?.actualInput, 'USB microphone');
});

test('empty selection never silently falls back to default microphone', async () => {
  const f = fixture(true, '');
  await assert.rejects(f.media.getUserMedia({ audio: true }), { name: 'NotFoundError' });
  assert.equal(f.calls.length, 0);
});

test('unexpected actual device stops every returned track and rejects capture', async () => {
  const f = fixture();
  const wrong = fakeStream('wrong-device');
  f.setHandler(async () => wrong);
  await assert.rejects(f.media.getUserMedia({ audio: true }), { name: 'NotReadableError' });
  assert.equal(wrong.audio.stops, 1);
  assert.equal(wrong.video.stops, 1);
});

test('input change closes existing streams and applies to the next voice connection', async () => {
  const f = fixture();
  await f.media.getUserMedia({ audio: true });
  f.command({ type: 'input', deviceId: 'origin-mic-two' });
  assert.equal(f.streams[0].audio.stops, 1);
  await f.media.getUserMedia({ audio: true });
  assert.equal(f.streams[1].audio.deviceId, 'origin-mic-two');
});

test('stop disables new capture and closes active streams', async () => {
  const f = fixture();
  await f.media.getUserMedia({ audio: true });
  f.command({ type: 'stop' });
  assert.equal(f.streams[0].audio.stops, 1);
  assert.equal(f.streams[0].video.stops, 1);
  await assert.rejects(f.media.getUserMedia({ audio: true }), { name: 'NotAllowedError' });
  assert.equal(f.calls.length, 1);
});

test('a request resolving after stop cannot leave an untracked microphone recording', async () => {
  const f = fixture();
  let resolve!: (stream: ReturnType<typeof fakeStream>) => void;
  f.setHandler(() => new Promise(done => { resolve = done; }));
  const pending = f.media.getUserMedia({ audio: true });
  f.command({ type: 'stop' });
  const late = fakeStream('origin-mic-one');
  resolve(late);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(late.audio.stops, 1);
  assert.equal(late.video.stops, 1);
});

test('device discovery uses assistant-origin IDs and opens no capture when labels exist', async () => {
  const f = fixture();
  assert.equal(f.command({ type: 'devices' }), true);
  assert.equal(f.reports.at(-1)?.message, 'Checking assistant microphones…');
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports.at(-1)?.devices?.[0].deviceId, 'origin-mic-one');
  assert.equal(f.reports.at(-1)?.error, '');
  assert.match(f.reports.at(-1)?.message || '', /Found 1 assistant audio input/);
});

test('empty discovery reports a failure and still closes its temporary microphone', async () => {
  const f = fixture();
  f.setDevices([]);
  f.command({ type: 'devices' });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.streams[0].audio.stops, 1);
  assert.equal(f.reports.at(-1)?.devices?.length, 0);
  assert.match(f.reports.at(-1)?.error || '', /no selectable microphone/);
});

test('enumeration denial clears stale devices and reports the bounded reason', async () => {
  const f = fixture();
  f.media.enumerateDevices = async () => { throw new DOMException('Device access denied.', 'NotAllowedError'); };
  f.command({ type: 'devices' });
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports.at(-1)?.devices?.length, 0);
  assert.match(f.reports.at(-1)?.error || '', /NotAllowedError: Device access denied/);
  assert.equal(f.reports.at(-1)?.message, 'Assistant microphone discovery failed.');
});

test('explicit label discovery immediately stops its temporary microphone', async () => {
  const f = fixture();
  f.setDevices([{ kind: 'audioinput', deviceId: 'hidden', label: '' }]);
  const temporary = fakeStream('default');
  f.setHandler(async () => {
    f.setDevices([{ kind: 'audioinput', deviceId: 'origin-mic-one', label: 'USB microphone' }]);
    return temporary;
  });
  f.command({ type: 'devices' });
  await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(temporary.audio.stops, 1);
  assert.equal(temporary.video.stops, 1);
  assert.equal(f.reports.at(-1)?.devices?.[0].label, 'USB microphone');
});

test('stop before enumeration resolves cancels discovery without starting capture', async () => {
  const f = fixture();
  f.setDevices([{ kind: 'audioinput', deviceId: 'hidden', label: '' }]);
  f.command({ type: 'devices' });
  f.command({ type: 'stop' });
  await flush();
  assert.equal(f.calls.length, 0);
  assert.equal(f.reports.some(report => report.devices), false);
});

test('temporary discovery stream resolving after stop is still closed', async () => {
  const f = fixture();
  f.setDevices([{ kind: 'audioinput', deviceId: 'hidden', label: '' }]);
  let resolve!: (stream: ReturnType<typeof fakeStream>) => void;
  f.setHandler(() => new Promise(done => { resolve = done; }));
  f.command({ type: 'devices' });
  await flush();
  f.command({ type: 'stop' });
  const late = fakeStream('default');
  resolve(late);
  await flush();
  assert.equal(late.audio.stops, 1);
  assert.equal(late.video.stops, 1);
  assert.equal(f.reports.some(report => report.devices), false);
});

test('input list omits aliases whose resolved physical ID cannot equal the alias', async () => {
  const f = fixture();
  f.setDevices([
    { kind: 'audioinput', deviceId: 'default', label: 'Default USB' },
    { kind: 'audioinput', deviceId: 'communications', label: 'Communications USB' },
    { kind: 'audioinput', deviceId: 'physical', label: 'USB' }
  ]);
  f.command({ type: 'devices' });
  await flush();
  assert.equal(JSON.stringify(f.reports.at(-1)?.devices), JSON.stringify([{ deviceId: 'physical', label: 'USB' }]));
});

test('devicechange enumerates without opening a microphone or switching devices', async () => {
  const f = fixture();
  f.setDevices([{ kind: 'audioinput', deviceId: 'other', label: '' }]);
  f.changed();
  await flush();
  assert.equal(f.calls.length, 0);
  f.setHandler(async () => { throw new DOMException('Selected microphone was removed.', 'OverconstrainedError'); });
  await assert.rejects(f.media.getUserMedia({ audio: true }), { name: 'OverconstrainedError' });
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.stringify((f.calls[0]?.audio as MediaTrackConstraints).deviceId), JSON.stringify({ exact: 'origin-mic-one' }));
});
