import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer, request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import vm from 'node:vm';
import { WebSocket } from 'ws';
import { LibraryStore } from '../library.js';
import { OverlayServer } from '../overlay.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vox-overlay-')); const legacy = path.join(root, 'legacy');
  for (const pose of ['closed', 'open']) { await fs.mkdir(path.join(legacy, `mouth_${pose}`), { recursive: true }); await fs.writeFile(path.join(legacy, `mouth_${pose}`, '1.png'), png); }
  const store = new LibraryStore(path.join(root, 'data'), legacy); const library = await store.load();
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()));
  await store.saveSettings({ ...library.settings, overlayPort: port }); const server = new OverlayServer(store); const origin = await server.start();
  return { root, store, server, origin, token: library.token, character: library.characters[0], cleanup: async () => { await server.stop(); await fs.rm(root, { recursive: true, force: true }); } };
}
function message(ws: WebSocket): Promise<any> { return new Promise((resolve, reject) => { const timer = setTimeout(() => { ws.removeListener('message', received); reject(new Error('WebSocket message timeout')); }, 2500); const received = (data: unknown) => { clearTimeout(timer); resolve(JSON.parse(String(data))); }; ws.once('message', received); }); }
test('authenticated OBS source is transparent and serves only managed image assets', async t => {
  const f = await fixture(); t.after(f.cleanup); const url = `${f.origin}/overlay/${f.character.id}?token=${f.token}`;
  assert.equal((await fetch(url.replace(f.token, 'wrong'))).status, 403); assert.equal((await fetch(url, { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  const response = await fetch(url); const html = await response.text(); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/); assert.match(response.headers.get('permissions-policy')!, /microphone=\(\)/); assert.match(html, /background:transparent/); assert.match(html, /pose='closed'/); assert.match(html, /img.decode\(\)/); assert.doesNotMatch(html, /getUserMedia|<audio/);
  const asset = await fetch(`${f.origin}/assets/${f.character.id}/${f.character.closed[0].file}?token=${f.token}`); assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  assert.equal((await fetch(`${f.origin}/assets/${f.character.id}/library.json?token=${f.token}`)).status, 404); assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});
test('requires the expected Host header to prevent DNS rebinding', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const status = await new Promise<number | undefined>((resolve, reject) => { const req = request(`${f.origin}/overlay/${f.character.id}?token=${f.token}`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
});
test('websocket snapshots, speaking transitions, stale idle and live character refresh recover correctly', async t => {
  const f = await fixture(); t.after(f.cleanup); const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin }); t.after(() => ws.terminate());
  const initial = await message(ws); assert.equal(initial.type, 'snapshot'); assert.equal(initial.state.speaking, false); assert.equal(initial.character.id, f.character.id);
  let next = message(ws); f.server.publish({ characterId: f.character.id, level: 0.6, db: -20, speaking: true, running: true }); const speech = await next; assert.equal(speech.state.speaking, true);
  next = message(ws); f.server.publish({ characterId: f.character.id, level: 0, db: -100, speaking: false, running: true }); const silence = await next; assert.equal(silence.state.speaking, false); assert.ok(silence.state.sequence > speech.state.sequence);
  next = message(ws); f.server.publish({ characterId: f.character.id, level: 0.6, db: -20, speaking: true, running: true }); await next;
  const stale = await message(ws); assert.equal(stale.state.speaking, false); assert.equal(stale.state.running, false);
  await f.store.saveCharacter({ ...f.character, name: 'Live edit' }); next = message(ws); f.server.refresh(); assert.equal((await next).character.name, 'Live edit');
  const second = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin }); t.after(() => second.terminate()); assert.equal((await message(second)).state.speaking, false);
});
test('websocket rejects missing or foreign Origin and exposes no control messages', async t => {
  const f = await fixture(); t.after(f.cleanup);
  for (const origin of [undefined, 'https://foreign.example']) {
    const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, origin ? { origin } : {}); ws.on('error', () => {}); const [code] = await once(ws, 'unexpected-response'); assert.ok(code); ws.terminate();
  }
  const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin }); ws.on('error', () => {}); await message(ws); const closed = once(ws, 'close'); ws.send('{"command":"capture-microphone"}'); assert.equal((await closed)[0], 1008);
});
test('actual overlay renderer starts closed, applies fast speech endings and idles after disconnect', async t => {
  const f = await fixture(); t.after(f.cleanup); const response = await fetch(`${f.origin}/overlay/${f.character.id}?token=${f.token}`); const html = await response.text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  let now = 1000; let render: (time: number) => void = () => {}; let socket: any; const children: any[] = [];
  const stage = { style: {} as Record<string, string>, replaceChildren: (...images: unknown[]) => { children.splice(0, children.length, ...images); } };
  class ImageFixture { style: Record<string, string> = {}; src = ''; async decode() {} }
  vm.runInNewContext(script, {
    document: { getElementById: () => stage }, Image: ImageFixture, innerWidth: 600, innerHeight: 600, location: { origin: f.origin }, performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => { render = callback; }, addEventListener: () => {}, clearTimeout: () => {}, setTimeout: () => 1,
    WebSocket: function () { socket = this; }, console, URL, Math
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  const visible = () => children.filter(image => image.style.display === 'block').map(image => image.src);
  render(now); assert.equal(visible().length, 1); assert.ok(visible()[0].includes(f.character.closed[0].file));
  socket.onopen(); const emit = (speaking: boolean) => socket.onmessage({ data: JSON.stringify({ type: 'state', state: { characterId: f.character.id, running: true, speaking } }) });
  emit(true); now += 20; render(now); assert.ok(visible()[0].includes(f.character.open[0].file));
  emit(false); now += 20; render(now); assert.ok(visible()[0].includes(f.character.closed[0].file));
  emit(true); now += 20; render(now); socket.onclose(); now += 20; render(now); assert.ok(visible()[0].includes(f.character.closed[0].file));
});
test('first animation-frame timestamp can precede initialization without breaking subsequent frames', async t => {
  const f = await fixture(); t.after(f.cleanup); const response = await fetch(`${f.origin}/overlay/${f.character.id}?token=${f.token}`); const html = await response.text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  let render: (time: number) => void = () => {}; let scheduled = 0; const children: any[] = [];
  const stage = { style: {}, replaceChildren: (...images: unknown[]) => { children.splice(0, children.length, ...images); } };
  class ImageFixture { style: Record<string, string> = {}; async decode() {} }
  vm.runInNewContext(script, {
    document: { getElementById: () => stage }, Image: ImageFixture, innerWidth: 600, innerHeight: 600, location: { origin: f.origin }, performance: { now: () => 1000 },
    requestAnimationFrame: (callback: (time: number) => void) => { render = callback; scheduled++; }, addEventListener: () => {}, clearTimeout: () => {}, setTimeout: () => 1,
    WebSocket: function () {}, console, URL, Math
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.doesNotThrow(() => render(999)); assert.equal(children.filter(image => image.style.display === 'block').length, 1); assert.equal(scheduled, 2);
  assert.doesNotThrow(() => render(1016)); assert.equal(children.filter(image => image.style.display === 'block').length, 1); assert.equal(scheduled, 3);
});
