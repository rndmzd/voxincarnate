import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { ControlServer } from '../control-server.js';
import { ControlConfigStore } from '../control-config.js';
import { Controls } from '../controls.js';
import { commandIssue, EMPTY_RUNTIME, parseCommand, parseControlSettings, type ControlState } from '../control-protocol.js';
import { LocalControlClient, parseConnection } from '../../streamdeck/src/client.js';
import { presentation } from '../../streamdeck/src/presentation.js';

const id = '12345678-1234-1234-1234-123456789abc';
const token = 'a'.repeat(64);
const state = (): ControlState => ({ ...EMPTY_RUNTIME, ready: true, selectedInputId: 'mic', inputs: [{ deviceId: 'mic', label: 'Test microphone' }],
  activeCharacterId: id, apiVersion: 1, revision: 1, characters: [{ id, name: 'Signal', visible: true, motions: { enter: ['smoke'], exit: ['smoke'] } }] });
async function temp(t: { after(fn: () => unknown): void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'vox-controls-'));
  t.after(async () => { assert(path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep)); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4500;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('State did not arrive.'); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test('control protocol accepts only supported commands and independent hotkeys', () => {
  assert.deepEqual(parseCommand({ action: 'character.enter', characterId: id, effect: 'smoke' }), { action: 'character.enter', characterId: id, effect: 'smoke' });
  for (const value of [null, [], { action: 'deleteCharacter' }, { action: 'audio.start', script: 'evil' }, { action: 'audio.stop', effect: 'walk' }, { action: 'character.exit', effect: 'unknown' }]) assert.throws(() => parseCommand(value));
  assert.throws(() => parseControlSettings({ enabled: true, port: 80, hotkeys: [] }));
  assert.throws(() => parseControlSettings({ enabled: true, port: 48242, hotkeys: ['a', 'b'].map(id => ({ id, accelerator: 'Ctrl+F9', command: { action: 'audio.start' } })) }));
  assert.deepEqual(parseControlSettings({ enabled: false, port: 48242, hotkeys: [] }), { enabled: false, port: 48242, hotkeys: [] });
});

test('guards preserve unsaved artwork, stopped refresh and per-character animation availability', () => {
  assert.equal(commandIssue({ ...state(), dirty: true }, { action: 'character.exit', effect: 'smoke' })?.code, 'unsaved_changes');
  assert.equal(commandIssue({ ...state(), running: true }, { action: 'inputs.refresh' })?.code, 'audio_running');
  assert.equal(commandIssue({ ...state(), busy: true, dirty: true }, { action: 'audio.stop' }), undefined);
  assert.equal(commandIssue({ ...state(), running: true, dirty: true }, { action: 'audio.start' }), undefined);
  assert.equal(commandIssue(state(), { action: 'character.enter', effect: 'walk' })?.code, 'animation_missing');
  assert.equal(commandIssue(state(), { action: 'character.enter' }), undefined);
  assert.equal(commandIssue({ ...state(), selectedInputId: '' }, { action: 'audio.start' })?.code, 'input_required');
});

test('control configuration persists a separate secret without changing the avatar library', async t => {
  const store = new ControlConfigStore(await temp(t));
  const first = await store.load(), second = await store.load();
  assert.equal(first.token.length, 64); assert.equal(first.token, second.token);
  assert.equal(first.hotkeys.length, 12); assert(first.hotkeys.every(binding => !binding.accelerator));
  assert(!JSON.stringify(first).includes('overlayToken'));
  await fs.writeFile(store.filename, '{invalid');
  await assert.rejects(store.load()); assert.equal(await fs.readFile(store.filename, 'utf8'), '{invalid');
});

test('authenticated API rejects browser origins, query tokens, writes to events and invalid payloads', async t => {
  let current = state(), calls = 0;
  const server = new ControlServer(token, () => current, async () => { calls++; return { ok: true, state: current }; });
  await server.start(0); t.after(() => server.stop());
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(`${server.origin}/v1/status`)).status, 403);
  assert.equal((await fetch(`${server.origin}/v1/status?token=${token}`)).status, 403);
  assert.equal((await fetch(`${server.origin}/v1/status`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
  const foreignHost = await new Promise<number>(resolve => { const req = request(`${server.origin}/v1/status`, { headers: { ...headers, Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode!); }); req.end(); });
  assert.equal(foreignHost, 403);
  const publicState = await (await fetch(`${server.origin}/v1/status`, { headers })).text();
  assert.equal(JSON.parse(publicState).apiVersion, 1); assert(!publicState.includes(token));
  const post = (body: string, type = 'application/json') => fetch(`${server.origin}/v1/commands`, { method: 'POST', headers: { ...headers, 'Content-Type': type }, body });
  assert.equal((await post('{bad')).status, 400);
  assert.equal((await post('{"action":"audio.start","script":"evil"}')).status, 400);
  assert.equal((await post('{"action":"audio.start"}', 'text/plain')).status, 415);
  assert.equal((await post(' '.repeat(4100))).status, 413);
  assert.equal((await post('{"action":"audio.start"}')).status, 200); assert.equal(calls, 1);
  const ws = new WebSocket(`${server.origin.replace('http:', 'ws:')}/v1/events`, { headers });
  ws.on('error', () => {}); t.after(() => ws.terminate());
  assert.equal(JSON.parse(String((await once(ws, 'message'))[0])).state.running, false);
  const next = once(ws, 'message'); current = { ...current, running: true }; server.broadcast();
  assert.equal(JSON.parse(String((await next)[0])).state.running, true);
  const closed = once(ws, 'close'); ws.send('{"action":"audio.stop"}'); assert.equal((await closed)[0], 1008);
});

test('hotkey saves roll back atomically and stop can interrupt a pending start', async t => {
  const config = new ControlConfigStore(await temp(t));
  const initial = await config.load(); await config.save({ ...initial, enabled: false });
  const keys = new Map<string, () => void>();
  let finish!: () => void, starts = 0, stops = 0;
  const controls = new Controls(config, { register: (key, callback) => { if (key === 'Used' || keys.has(key)) return false; keys.set(key, callback); return true; }, unregister: key => { keys.delete(key); } }, () => state().characters,
    async command => { if (command.action === 'audio.start') { starts++; await new Promise<void>(resolve => { finish = resolve; }); } else if (command.action === 'audio.stop') stops++; return { ok: true }; });
  await controls.start(); t.after(() => controls.stop()); controls.update(state());
  await controls.save({ enabled: false, port: 48242, hotkeys: [{ id: 'start', accelerator: 'Ctrl+Alt+F9', command: { action: 'audio.start' } }] });
  await assert.rejects(controls.save({ enabled: false, port: 48242, hotkeys: [{ id: 'bad', accelerator: 'Used', command: { action: 'audio.stop' } }] }));
  assert(keys.has('Ctrl+Alt+F9')); assert.equal(controls.info().settings.hotkeys[0].id, 'start');
  keys.get('Ctrl+Alt+F9')!(); await until(() => starts === 1);
  assert.equal((await controls.execute({ action: 'character.exit' })).code, 'busy');
  assert.equal((await controls.execute({ action: 'audio.stop' })).ok, true); assert.equal(stops, 1);
  finish(); await until(() => !controls.state().busy);
  assert.equal((await controls.execute({ action: 'unknown' })).code, 'invalid_command');
});

test('invalid optional control settings leave the studio usable and preserve the original file', async t => {
  const config = new ControlConfigStore(await temp(t));
  await fs.writeFile(config.filename, '{invalid');
  const controls = new Controls(config, { register: () => true, unregister: () => {} }, () => [], async () => ({ ok: true }));
  await controls.start(); t.after(() => controls.stop());
  assert.equal(controls.info().listening, false); assert(controls.info().error?.includes('preserved'));
  assert.equal(await fs.readFile(config.filename, 'utf8'), '{invalid');
  controls.update(state()); assert.equal(controls.state().ready, true);
});

test('a control-port collision preserves the existing authenticated connection and saved settings', async t => {
  const config = new ControlConfigStore(await temp(t));
  const initial = await config.load();
  const reserved = new ControlServer(token, state, async () => ({ ok: true, state: state() }));
  await reserved.start(0); t.after(() => reserved.stop());
  const old = new ControlServer(token, state, async () => ({ ok: true, state: state() }));
  await old.start(0); const freePort = Number(new URL(old.origin).port); await old.stop();
  await config.save({ ...initial, port: freePort });
  const controls = new Controls(config, { register: () => true, unregister: () => {} }, () => state().characters, async () => ({ ok: true }));
  await controls.start(); t.after(() => controls.stop()); controls.update(state());
  await assert.rejects(controls.save({ enabled: true, port: Number(new URL(reserved.origin).port), hotkeys: [] }));
  const response = await fetch(`http://127.0.0.1:${freePort}/v1/status`, { headers: { Authorization: `Bearer ${initial.token}` } });
  assert.equal(response.status, 200); assert.equal(controls.info().settings.port, freePort); assert.equal((await config.load()).port, freePort);
});

test('plugin uses actual state, reconnects, and never replays commands', async t => {
  let current = state(), calls = 0;
  let server = new ControlServer(token, () => current, async () => { calls++; current = { ...current, running: true }; server.broadcast(); return { ok: true, state: current }; });
  await server.start(0); const port = Number(new URL(server.origin).port);
  const client = new LocalControlClient(); t.after(async () => { client.close(); await server.stop(); });
  client.connect({ port, token }); await until(() => !!client.state);
  assert.equal(presentation({ action: 'audio.toggle' }, client.state).title, 'Start\naudio');
  assert.equal((await client.execute({ action: 'audio.start' })).ok, true);
  assert.equal(presentation({ action: 'audio.toggle' }, client.state).title, 'Stop\naudio');
  await server.stop(); await until(() => !client.state);
  assert.equal(presentation({ action: 'audio.toggle' }, client.state).title, 'App\noffline');
  server = new ControlServer(token, () => current, async () => { calls++; return { ok: true, state: current }; });
  await server.start(port); await until(() => !!client.state); assert.equal(calls, 1);
  assert.throws(() => parseConnection({ port: 443, token })); assert.throws(() => parseConnection({ port, token: 'bad' }));
});
