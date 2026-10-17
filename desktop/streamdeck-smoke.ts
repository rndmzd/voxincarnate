import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import { ControlServer } from './control-server.js';
import { EMPTY_RUNTIME, type ControlCommand, type ControlState } from './control-protocol.js';

const folder = path.resolve('build/streamdeck/com.voxincarnate.streamdeck.sdPlugin');
const id = '12345678-1234-1234-1234-123456789abc', otherId = '12345678-1234-1234-1234-123456789abd';
const token = 'b'.repeat(64);
let state: ControlState = { ...EMPTY_RUNTIME, apiVersion: 1, revision: 1, ready: true, activeCharacterId: id, selectedInputId: 'mic', inputs: [{ deviceId: 'mic', label: 'Fixture microphone' }],
  characters: [id, otherId].map((id, i) => ({ id, name: i ? 'Second character' : 'Signal', visible: true, motions: { enter: ['smoke'], exit: ['smoke'] } })) };
const commands: ControlCommand[] = [];
const invoke = async (command: ControlCommand) => {
  commands.push(command);
  if (command.action === 'audio.start') state.running = true;
  if (command.action === 'audio.stop') state.running = false;
  if (command.action.startsWith('character.')) state.characters.find(c => c.id === (command.characterId ?? id))!.visible = command.action === 'character.enter';
  ++state.revision; server.broadcast(); return { ok: true, state };
};
let server = new ControlServer(token, () => structuredClone(state), invoke);
await server.start(0); const controlPort = Number(new URL(server.origin).port);
const sd = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(sd, 'listening');
const messages: Record<string, any>[] = [];
let socket: WebSocket;
sd.on('connection', ws => {
  socket = ws;
  ws.on('message', bytes => {
    const message = JSON.parse(String(bytes)); messages.push(message);
    if (message.event === 'getGlobalSettings') ws.send(JSON.stringify({ event: 'didReceiveGlobalSettings', id: message.id, payload: { settings: {} } }));
  });
});
const application = { version: '7.1.0', language: 'en', platform: 'windows', platformVersion: '10.0', font: 'Segoe UI' };
const child = spawn(process.execPath, [path.join(folder, 'bin/plugin.js'), '-port', String((sd.address() as { port: number }).port), '-pluginUUID', 'vox-fixture', '-registerEvent', 'registerPlugin', '-info', JSON.stringify({ application, devices: [{ id: 'fixture', name: 'Stream Deck fixture', type: 0, size: { columns: 5, rows: 3 } }], plugin: { version: '1.0.0.0', uuid: 'com.voxincarnate.streamdeck' } })], { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'] });
let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
const wait = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (child.exitCode !== null) throw new Error(`Plugin exited (${child.exitCode}): ${output}`);
    if (Date.now() > deadline) throw new Error(`${label}. Plugin output: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const send = (event: string, action: string, settings = {}) => socket.send(JSON.stringify({ event, action: `com.voxincarnate.streamdeck.${action}`, context: action, device: 'fixture', payload: { settings, controller: 'Keypad', state: 0, isInMultiAction: false, coordinates: { column: 0, row: 0 } } }));
const lastTitle = (action: string) => messages.filter(m => m.event === 'setTitle' && m.context === action).at(-1)?.payload.title;
const report: Record<string, unknown> = { ok: true, physicalStreamDeck: 'NOT RUN' };
try {
  await wait(() => messages.some(m => m.event === 'getGlobalSettings'), 'SDK did not register');
  send('willAppear', 'audio.start'); send('willAppear', 'audio.stop'); send('willAppear', 'character.exit', { characterId: otherId, effect: 'smoke' });
  await wait(() => lastTitle('audio.start') === 'App\noffline', 'Offline state missing');
  send('propertyInspectorDidAppear', 'audio.start');
  socket!.send(JSON.stringify({ event: 'sendToPlugin', action: 'com.voxincarnate.streamdeck.audio.start', context: 'audio.start', payload: { event: 'pair', code: JSON.stringify({ port: controlPort, token }) } }));
  await wait(() => lastTitle('audio.start') === 'Start\naudio', 'Pairing failed');
  send('keyDown', 'audio.start'); await wait(() => lastTitle('audio.start') === 'Capturing', 'Capture state did not update');
  send('keyDown', 'audio.stop'); await wait(() => !state.running && lastTitle('audio.start') === 'Start\naudio', 'Stop state did not update');
  send('keyDown', 'character.exit', { characterId: otherId, effect: 'smoke' });
  await wait(() => lastTitle('character.exit') === 'Smoke out\nHidden', 'Specific character exit failed');
  assert.equal(state.characters[0].visible, true); assert.equal(state.characters[1].visible, false);
  assert.deepEqual(commands.at(-1), { action: 'character.exit', characterId: otherId, effect: 'smoke' });
  state.dirty = true; server.broadcast(); await wait(() => lastTitle('audio.start') === 'Save\nchanges', 'Unsaved state missing');
  const before = commands.length; send('keyDown', 'audio.start'); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(commands.length, before);
  state.dirty = false; server.broadcast();
  await server.stop(); await wait(() => lastTitle('audio.start') === 'App\noffline', 'Disconnected state missing');
  server = new ControlServer(token, () => structuredClone(state), invoke); await server.start(controlPort);
  await wait(() => lastTitle('audio.start') === 'Start\naudio', 'Reconnect failed'); assert.equal(commands.length, before);
  assert(messages.some(m => m.event === 'setGlobalSettings' && m.payload.token === token));
  assert(!messages.some(m => m.event === 'setSettings' && JSON.stringify(m).includes(token)));
  assert(!output.includes(token));
  Object.assign(report, { officialSdkRegistration: true, pairing: true, actualCaptureFeedback: true, specificCharacterExit: true, unsavedGuard: true, reconnectWithoutReplay: true, credentialsExcludedFromActionSettings: true });
} catch (error) { report.ok = false; report.error = (error as Error).stack; report.eventTypes = messages.map(m => ({ event: m.event, context: m.context, title: m.event === 'setTitle' ? m.payload.title : undefined })); }
finally {
  child.kill(); for (const ws of sd.clients) ws.terminate(); await new Promise<void>(resolve => sd.close(() => resolve())); await server.stop();
}
await fs.mkdir('.qa', { recursive: true }); await fs.writeFile('.qa/streamdeck.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2)); if (!report.ok) process.exitCode = 1;
