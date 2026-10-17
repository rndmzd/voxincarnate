import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
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
import { createAvatarAnimator } from '../animation.js';
import type { Articulation, AvatarState, Character } from '../shared.js';

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
  const response = await fetch(url); const html = await response.text(); assert.equal(response.status, 200); assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/); assert.match(response.headers.get('permissions-policy')!, /microphone=\(\)/); assert.match(html, /background:transparent/); assert.match(html, /createAvatarAnimator/); assert.match(html, /img.decode\(\)/); assert.doesNotMatch(html, /getUserMedia|<audio/);
  const asset = await fetch(`${f.origin}/assets/${f.character.id}/${f.character.closed[0].file}?token=${f.token}`); assert.equal(asset.status, 200); assert.equal(asset.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  assert.equal((await fetch(`${f.origin}/assets/${f.character.id}/library.json?token=${f.token}`)).status, 404); assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});
test('requires the expected Host header to prevent DNS rebinding', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const status = await new Promise<number | undefined>((resolve, reject) => { const req = request(`${f.origin}/overlay/${f.character.id}?token=${f.token}`, { headers: { Host: 'attacker.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
  assert.equal(status, 403);
});
test('only authenticated image assets allow local file studio origins for alpha measurement', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const assetUrl = `${f.origin}/assets/${f.character.id}/${f.character.closed[0].file}?token=${f.token}`;
  for (const origin of ['null', 'file://']) {
    const asset = await fetch(assetUrl, { headers: { Origin: origin } });
    assert.equal(asset.status, 200); assert.equal(asset.headers.get('access-control-allow-origin'), origin); assert.equal(asset.headers.get('vary'), 'Origin');
    assert.equal((await fetch(assetUrl, { method: 'HEAD', headers: { Origin: origin } })).status, 200);
    assert.equal((await fetch(assetUrl.replace(f.token, 'wrong'), { headers: { Origin: origin } })).status, 403);
    assert.equal((await fetch(`${f.origin}/overlay/${f.character.id}?token=${f.token}`, { headers: { Origin: origin } })).status, 403);
    assert.equal((await fetch(`${f.origin}/events?token=${f.token}`, { headers: { Origin: origin } })).status, 403);
    const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin });
    ws.on('error', () => {}); await once(ws, 'unexpected-response'); ws.terminate();
  }
  assert.equal((await fetch(assetUrl, { headers: { Origin: 'https://foreign.example' } })).status, 403);
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
test('deleting a character clears its connected OBS source, rejects old URLs and discards live state', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const secondId = randomUUID(); const sprites = await f.store.importImageBuffers(secondId, [{ name: 'closed.png', png }, { name: 'open.png', png }]);
  await f.store.saveCharacter({ ...f.character, id: secondId, name: 'Remaining character', closed: [sprites[0]], open: [sprites[1]] });
  const first = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin });
  const second = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${secondId}`, { origin: f.origin });
  t.after(() => { first.terminate(); second.terminate(); });
  await Promise.all([message(first), message(second)]);
  let states = Promise.all([message(first), message(second)]);
  f.server.setPresence(f.character.id, false); await states;
  states = Promise.all([message(first), message(second)]);
  f.server.publish({ characterId: f.character.id, level: 0.8, db: -15, speaking: true, running: true, articulation: { audioTimeMs: 1000, weights: { D: 1 } } }); await states;
  await f.store.deleteCharacter(f.character.id);
  const deleted = message(first); const closed = once(first, 'close'); const remaining = message(second);
  f.server.refresh();
  assert.deepEqual(await deleted, { type: 'deleted', characterId: f.character.id });
  assert.equal((await closed)[0], 4004);
  const snapshot = await remaining; assert.equal(snapshot.type, 'snapshot'); assert.equal(snapshot.character.id, secondId); assert.equal(snapshot.state.running, false);
  assert.equal((await fetch(`${f.origin}/overlay/${f.character.id}?token=${f.token}`)).status, 404);
  assert.equal((await fetch(`${f.origin}/assets/${f.character.id}/${f.character.closed[0].file}?token=${f.token}`)).status, 404);
  assert.throws(() => f.server.setPresence(f.character.id, true), /valid character/);
  const rejected = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin });
  rejected.on('error', () => {}); const refused = once(rejected, 'unexpected-response');
  const [, response] = await refused; assert.equal(response.statusCode, 403); rejected.terminate();
  // Reusing an ID must not revive deleted presence, speech or an articulation clock.
  const fresh = await f.store.importImageBuffers(f.character.id, [{ name: 'closed.png', png }, { name: 'open.png', png }]);
  await f.store.saveCharacter({ ...f.character, closed: [fresh[0]], open: [fresh[1]] });
  const recreated = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin }); t.after(() => recreated.terminate());
  const initial = await message(recreated); assert.equal(initial.state.running, false); assert.equal(initial.state.articulation, undefined); assert.deepEqual(initial.state.presence, { visible: true, sequence: 0 });
  const speech = message(recreated);
  f.server.publish({ characterId: f.character.id, level: 0.5, db: -20, speaking: true, running: true, articulation: { audioTimeMs: 10, weights: { A: 1 } } });
  assert.deepEqual((await speech).state.articulation, { audioTimeMs: 10, weights: { A: 1 } });
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
test('actual OBS renderer immediately removes artwork and smoke, cancels decoded updates and stops reconnecting after deletion', async t => {
  for (const signal of ['message', 'close'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const character: Character = { ...f.character, motions: { exit: { effect: 'smoke', frames: [], frameMs: 100, durationMs: 1000, side: 'right' } } };
    await f.store.saveCharacter(character);
    const html = await (await fetch(`${f.origin}/overlay/${character.id}?token=${f.token}`)).text();
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
    let now = 1000; let render: (time: number) => void = () => {}; let socket: any; let scheduled = 0; let reconnects = 0; let closes = 0; let blockDecode = false;
    const children: any[] = []; const pendingDecodes: (() => void)[] = []; const paint: string[] = [];
    const stage = { style: {}, replaceChildren: (...images: unknown[]) => { children.splice(0, children.length, ...images); } };
    const context = { clearRect() { paint.push('clear'); }, save() {}, restore() {}, translate() {}, beginPath() {}, arc() { paint.push('smoke'); }, fill() {}, createRadialGradient() { return { addColorStop() {} }; } };
    const canvas = { style: {}, getContext: () => context };
    class ImageFixture {
      style: Record<string, string> = {}; src = ''; naturalWidth = 1; naturalHeight = 1;
      decode() { return new Promise<void>(resolve => { if (blockDecode) pendingDecodes.push(resolve); else resolve(); }); }
    }
    vm.runInNewContext(script, {
      document: { getElementById: (id: string) => id === 'stage' ? stage : canvas, createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) }) }) },
      Image: ImageFixture, innerWidth: 600, innerHeight: 600, location: { origin: f.origin }, performance: { now: () => now },
      requestAnimationFrame: (callback: (time: number) => void) => { render = callback; scheduled++; }, addEventListener: () => {}, clearTimeout: () => {}, setTimeout: () => { reconnects++; return 1; },
      WebSocket: function () { socket = this; socket.close = () => { closes++; }; }, console, URL, Math
    });
    await new Promise<void>(resolve => setImmediate(resolve)); socket.onopen(); render(now);
    assert.equal(children.filter(image => image.style.display === 'block').length, 1);
    socket.onmessage({ data: JSON.stringify({ type: 'state', state: { characterId: character.id, running: true, speaking: true, presence: { visible: false, sequence: 1 } } }) });
    now = 1500; render(now); assert.ok(paint.includes('smoke'));
    blockDecode = true;
    const snapshot = { type: 'snapshot', character, state: { characterId: character.id, running: true, speaking: true, presence: { visible: true, sequence: 2 } } };
    socket.onmessage({ data: JSON.stringify(snapshot) }); assert.equal(pendingDecodes.length, 2);
    const framesBeforeDelete = scheduled;
    if (signal === 'message') socket.onmessage({ data: JSON.stringify({ type: 'deleted', characterId: character.id }) });
    else socket.onclose({ code: 4004 });
    assert.equal(children.length, 0); assert.equal(paint.at(-1), 'clear'); assert.equal(closes, 1);
    const paintsAfterDelete = paint.length;
    for (const resolve of pendingDecodes) resolve();
    await new Promise<void>(resolve => setImmediate(resolve));
    socket.onmessage({ data: JSON.stringify(snapshot) }); socket.onclose({ code: 1000 }); render(1600); render(2200);
    assert.equal(children.length, 0, 'pending or queued snapshots cannot restore deleted artwork');
    assert.equal(paint.length, paintsAfterDelete, 'deleted effects no longer render');
    assert.equal(scheduled, framesBeforeDelete, 'the animation loop stops'); assert.equal(reconnects, 0);
  }
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

test('articulation transport bounds weights, rejects stale audio clocks and resets after Stop', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const ws = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin });
  t.after(() => ws.terminate()); await message(ws);
  const publish = (articulation?: Articulation, running = true) => f.server.publish({ characterId: f.character.id, level: 0.5, db: -20, speaking: running, running, ...(articulation ? { articulation } : {}) });
  let next = message(ws); publish({ audioTimeMs: 100, weights: { D: 1 } }); const first = await next;
  next = message(ws);
  for (const invalid of [{ audioTimeMs: NaN, weights: { D: 1 } }, { audioTimeMs: -1, weights: { D: 1 } }, { audioTimeMs: 110, weights: { D: Infinity } }, { audioTimeMs: 110, weights: { D: 1.1 } }, { audioTimeMs: 110, weights: { unknown: 1 } }, { audioTimeMs: 110, weights: {} }]) publish(invalid as Articulation);
  publish({ audioTimeMs: 120, weights: { E: 0.8, F: 0.2 } }); const valid = await next;
  assert.equal(valid.state.sequence, first.state.sequence + 1);
  assert.deepEqual(valid.state.articulation, { audioTimeMs: 120, weights: { E: 0.8, F: 0.2 } });
  next = message(ws); publish({ audioTimeMs: 110, weights: { A: 1 } }); assert.deepEqual((await next).state.articulation, valid.state.articulation);
  next = message(ws); publish({ audioTimeMs: 120, weights: { G: 1 } }); assert.equal((await next).state.articulation.weights.G, 1);
  next = message(ws); publish({ audioTimeMs: 0, weights: { X: 1 } }, false); assert.equal((await next).state.articulation, undefined);
  next = message(ws); publish({ audioTimeMs: 10, weights: { B: 1 } }); assert.equal((await next).state.articulation.audioTimeMs, 10);
});

async function visemeHarness(f: Awaited<ReturnType<typeof fixture>>, failedFile?: string) {
  const sprites = await f.store.importImageBuffers(f.character.id, ['A', 'C', 'D', 'X'].map(name => ({ name: `${name}.png`, png })));
  const character: Character = { ...f.character, animationMode: 'viseme', visemes: Object.fromEntries(['A', 'C', 'D', 'X'].map((pose, index) => [pose, [sprites[index]]])) };
  await f.store.saveCharacter(character);
  const html = await (await fetch(`${f.origin}/overlay/${f.character.id}?token=${f.token}`)).text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  let now = 1000; let render: (time: number) => void = () => {}; let socket: any; const children: any[] = [];
  const stage = { style: {}, replaceChildren: (...images: unknown[]) => { children.splice(0, children.length, ...images); } };
  class ImageFixture {
    style: Record<string, string> = {}; src = '';
    async decode() { if (failedFile && this.src.includes(sprites.find(sprite => sprite.name === failedFile)!.file)) throw new Error('Unavailable asset'); }
  }
  vm.runInNewContext(script, {
    document: { getElementById: () => stage }, Image: ImageFixture, innerWidth: 600, innerHeight: 600, location: { origin: f.origin }, performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => { render = callback; }, addEventListener: () => {}, clearTimeout: () => {}, setTimeout: () => 1,
    WebSocket: function () { socket = this; }, console, URL, Math
  });
  await new Promise<void>(resolve => setImmediate(resolve)); socket.onopen();
  const visible = () => { const selected = children.filter(image => image.style.display === 'block'); assert.equal(selected.length, 1); return selected[0].src as string; };
  return { character, socket, visible,
    at(time: number) { now = time; render(now); return visible(); },
    emit(pose: 'A' | 'C' | 'D' | 'X', time: number, running = true) {
      now = time;
      const state = { characterId: character.id, running, speaking: running, articulation: { audioTimeMs: time, weights: { [pose]: 1 } } };
      socket.onmessage({ data: JSON.stringify({ type: 'state', state }) }); return state;
    }
  };
}

test('actual OBS viseme renderer matches studio selection, preserves rapid closures and idles stale input', async t => {
  const f = await fixture(); t.after(f.cleanup); const h = await visemeHarness(f); const studio = createAvatarAnimator();
  let state: Pick<AvatarState, 'running' | 'speaking' | 'articulation'> = { running: false, speaking: false };
  const compare = (time: number) => {
    studio.update(h.character, state, time); const selected = studio.frame(time)!;
    assert.ok(h.at(time).includes(selected.file), `studio and OBS agree at ${time} ms`);
  };
  compare(1000);
  state = h.emit('D', 1010); compare(1010); assert.ok(h.visible().includes(h.character.visemes!.C![0].file));
  compare(1026); compare(1042); assert.ok(h.visible().includes(h.character.visemes!.D![0].file));
  state = h.emit('A', 1043); compare(1043); assert.ok(h.visible().includes(h.character.visemes!.A![0].file));
  state = h.emit('D', 1044); compare(1044);
  state = h.emit('X', 1045, false); compare(1045); compare(1100);
  state = h.emit('D', 1101); compare(1101); compare(1133);
  state = { running: false, speaking: false }; compare(1752); assert.ok(h.visible().includes(h.character.visemes!.X![0].file));
  state = h.emit('D', 1760); compare(1760); compare(1792);
  h.socket.onclose(); assert.ok(h.at(1793).includes(h.character.visemes!.X![0].file));
});

test('a failed decoded bilabial sprite falls back closed instead of holding an open pose', async t => {
  const f = await fixture(); t.after(f.cleanup); const h = await visemeHarness(f, 'A.png');
  h.emit('D', 1000); h.at(1000); assert.ok(h.at(1032).includes(h.character.visemes!.D![0].file));
  h.emit('A', 1033); assert.ok(h.at(1033).includes(h.character.closed[0].file));
});

test('presence is isolated per character, survives stopped or stale audio, and ignores renderer spoofing', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const secondId = randomUUID(); const sprites = await f.store.importImageBuffers(secondId, [{ name: 'closed.png', png }, { name: 'open.png', png }]);
  await f.store.saveCharacter({ ...f.character, id: secondId, name: 'Second character', closed: [sprites[0]], open: [sprites[1]] });
  const first = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${f.character.id}`, { origin: f.origin });
  const second = new WebSocket(`${f.origin.replace('http:', 'ws:')}/events?token=${f.token}&characterId=${secondId}`, { origin: f.origin });
  t.after(() => { first.terminate(); second.terminate(); });
  const snapshots = await Promise.all([message(first), message(second)]);
  for (const snapshot of snapshots) assert.deepEqual(snapshot.state.presence, { visible: true, sequence: 0 });
  assert.throws(() => f.server.setPresence('missing-character', false), /valid character/);
  assert.throws(() => f.server.setPresence(f.character.id, 'false' as unknown as boolean), /visibility/);
  let next = Promise.all([message(first), message(second)]);
  const presence = f.server.setPresence(f.character.id, false); presence.visible = true;
  let states = await next;
  assert.deepEqual(states[0].state.presence, { visible: false, sequence: 1 });
  assert.deepEqual(states[1].state.presence, { visible: true, sequence: 0 });
  next = Promise.all([message(first), message(second)]);
  f.server.publish({ characterId: f.character.id, level: 0.5, db: -20, running: true, speaking: true, presence: { visible: true, sequence: 9999 } });
  states = await next;
  assert.equal(states[0].state.speaking, true);
  assert.deepEqual(states[0].state.presence, { visible: false, sequence: 1 });
  next = Promise.all([message(first), message(second)]);
  states = await next;
  assert.equal(states[0].state.running, false);
  assert.deepEqual(states[0].state.presence, { visible: false, sequence: 1 });
  next = Promise.all([message(first), message(second)]);
  f.server.publish({ characterId: secondId, level: 0, db: -100, running: false, speaking: false });
  states = await next;
  assert.deepEqual(states[0].state.presence, { visible: false, sequence: 1 });
  assert.deepEqual(states[1].state.presence, { visible: true, sequence: 0 });
  const refreshed = message(first); f.server.refresh();
  assert.deepEqual((await refreshed).state.presence, { visible: false, sequence: 1 });
  next = Promise.all([message(first), message(second)]);
  assert.deepEqual(f.server.setPresence(f.character.id, true), { visible: true, sequence: 2 });
  states = await next;
  assert.deepEqual(states[0].state.presence, { visible: true, sequence: 2 });
});

test('actual OBS walking renderer preloads gait, crosses a wide canvas and keeps presence through audio disconnection', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const sprites = await f.store.importImageBuffers(f.character.id, [{ name: 'enter.png', png }, { name: 'exit.png', png }]);
  const character: Character = { ...f.character, motions: {
    enter: { frames: [sprites[0]], frameMs: 100, durationMs: 1000, side: 'left' },
    exit: { frames: [sprites[1]], frameMs: 100, durationMs: 1000, side: 'right' }
  } };
  await f.store.saveCharacter(character);
  const html = await (await fetch(`${f.origin}/overlay/${character.id}?token=${f.token}`)).text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  let now = 1000; let render: (time: number) => void = () => {}; let socket: any; const children: any[] = [];
  const stage = { style: {}, replaceChildren: (...images: unknown[]) => { children.splice(0, children.length, ...images); } };
  class ImageFixture { style: Record<string, string> = {}; src = ''; async decode() {} }
  vm.runInNewContext(script, {
    document: { getElementById: () => stage }, Image: ImageFixture, innerWidth: 1200, innerHeight: 600, location: { origin: f.origin }, performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => { render = callback; }, addEventListener: () => {}, clearTimeout: () => {}, setTimeout: () => 1,
    WebSocket: function () { socket = this; }, console, URL, Math
  });
  await new Promise<void>(resolve => setImmediate(resolve)); socket.onopen();
  assert.equal(children.length, 4);
  const visible = () => children.filter(image => image.style.display === 'block');
  const emit = (show: boolean, sequence: number) => socket.onmessage({ data: JSON.stringify({ type: 'state', state: { characterId: character.id, running: false, speaking: false, presence: { visible: show, sequence } } }) });
  render(now); assert.ok(visible()[0].src.includes(character.closed[0].file));
  emit(false, 1); render(now); assert.ok(visible()[0].src.includes(sprites[1].file));
  now = 1500; render(now); assert.match(visible()[0].style.transform, /translate\(450px,0px\)/);
  socket.onclose(); now = 1800; render(now); assert.ok(visible()[0].src.includes(sprites[1].file));
  now = 2000; render(now); assert.equal(visible().length, 0);
  now = 2001; emit(true, 2); render(now);
  assert.ok(visible()[0].src.includes(sprites[0].file)); assert.match(visible()[0].style.transform, /translate\(-900px,0px\)/);
  now = 2501; emit(true, 2); render(now); assert.match(visible()[0].style.transform, /translate\(-450px,0px\)/);
  now = 3001; render(now); assert.ok(visible()[0].src.includes(character.closed[0].file)); assert.match(visible()[0].style.transform, /translate\(0px,0px\)/);
});

async function effectHarness(f: Awaited<ReturnType<typeof fixture>>, character: Character) {
  await f.store.saveCharacter(character);
  const html = await (await fetch(`${f.origin}/overlay/${character.id}?token=${f.token}`)).text();
  const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)![1];
  let now = 1000; let render: (time: number) => void = () => {}; let socket: any; const children: any[] = []; const smokeCalls: string[] = [];
  const stage = { style: {}, replaceChildren: (...images: unknown[]) => { children.splice(0, children.length, ...images); } };
  const smokeContext = { clearRect() { smokeCalls.push('clear'); }, save() {}, restore() {}, translate() {}, beginPath() {}, arc() { smokeCalls.push('arc'); }, fill() {}, createRadialGradient() { return { addColorStop() {} }; } };
  const smokeCanvas = { style: {}, getContext: () => smokeContext };
  const pixels = new Uint8ClampedArray(600 * 600 * 4);
  for (let y = 180; y < 420; y++) for (let x = 240; x < 360; x++) pixels[(y * 600 + x) * 4 + 3] = 255;
  class ImageFixture { style: Record<string, string> = {}; src = ''; naturalWidth = 600; naturalHeight = 600; async decode() {} }
  vm.runInNewContext(script, {
    document: {
      getElementById: (id: string) => id === 'stage' ? stage : smokeCanvas,
      createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) })
    },
    Image: ImageFixture, innerWidth: 1200, innerHeight: 600, location: { origin: f.origin }, performance: { now: () => now },
    requestAnimationFrame: (callback: (time: number) => void) => { render = callback; }, addEventListener: () => {}, clearTimeout: () => {}, setTimeout: () => 1,
    WebSocket: function () { socket = this; }, console, URL, Math
  });
  await new Promise<void>(resolve => setImmediate(resolve)); socket.onopen();
  return {
    smokeCalls, socket, children,
    at(time: number) { now = time; render(now); return children.filter(image => image.style.display === 'block'); },
    emit(show: boolean, sequence: number) { socket.onmessage({ data: JSON.stringify({ type: 'state', state: { characterId: character.id, running: false, speaking: false, presence: { visible: show, sequence } } }) }); }
  };
}

test('actual OBS renderer measures transparent padding and transformed art so right entrance touches the viewport edge immediately', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const sprite = { ...f.character.closed[0], x: 30, y: -15, scale: 1.25 };
  const character: Character = { ...f.character, closed: [{ ...f.character.closed[0], scale: 3 }], open: [{ ...f.character.open[0], scale: 3 }], motions: {
    enter: { frames: [{ ...sprite, id: randomUUID() }], frameMs: 100, durationMs: 1000, side: 'right', facing: 'right' },
    exit: { frames: [{ ...sprite, id: randomUUID() }], frameMs: 100, durationMs: 1000, side: 'right', facing: 'right' }
  } };
  const h = await effectHarness(f, character);
  h.emit(false, 1); h.at(2000);
  h.emit(true, 2);
  const first = h.at(2000)[0];
  // The 120px alpha silhouette scales to 150px: center 675 minus half-width 75 touches x=600.
  assert.match(first.style.transform, /translate\(675px,-15px\) scale\(-1.25,1.25\)/);
  assert.equal(first.style.opacity, '1');
  const next = h.at(2001)[0].style.transform as string;
  const x = Number(next.match(/translate\((-?[0-9.]+)px,-15px\)/)![1]);
  assert.ok(x - 75 < 600, 'the next frame has visible pixels inside the viewport');
  h.at(3000); h.emit(false, 3);
  assert.match(h.at(3500)[0].style.transform, /scale\(1.25,1.25\)/, 'same-side exit faces right');
  assert.equal(h.at(4000).length, 0);
});

test('actual OBS smoke and fall effects use unchanged fallback artwork and keep running when audio disconnects', async t => {
  for (const effect of ['smoke', 'fall-jump'] as const) {
    const f = await fixture(); t.after(f.cleanup);
    const character: Character = { ...f.character, motions: {
      enter: { effect, frames: [], frameMs: 100, durationMs: 1000, side: 'right' },
      exit: { effect, frames: [], frameMs: 100, durationMs: 1000, side: 'right' }
    } };
    const h = await effectHarness(f, character);
    h.emit(false, 1); h.at(2000); assert.equal(h.at(2000).length, 0);
    h.emit(true, 2); const first = h.at(2000)[0];
    assert.ok(first.src.includes(character.closed[0].file));
    if (effect === 'smoke') assert.equal(first.style.opacity, '0');
    else assert.match(first.style.transform, /translate\(0px,-420px\)/);
    h.socket.onclose();
    h.at(2500);
    if (effect === 'smoke') assert.ok(h.smokeCalls.includes('arc'), 'actual puff canvas was painted');
    assert.equal(h.at(3000).length, 1);
    h.emit(false, 3); h.at(4000); assert.equal(h.at(4100).length, 0);
  }
});
