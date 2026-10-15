import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryStore } from '../library.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vox-library-')); const legacy = path.join(root, 'legacy');
  for (const pose of ['closed', 'open']) { await fs.mkdir(path.join(legacy, `mouth_${pose}`), { recursive: true }); await fs.writeFile(path.join(legacy, `mouth_${pose}`, '1.png'), png); }
  const store = new LibraryStore(path.join(root, 'data'), legacy); return { root, legacy, store };
}
test('seeds managed artwork and preserves token, IDs, settings and character edits through restart', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); const initial = await f.store.load();
  assert.equal(initial.settings.assistantUrl, 'https://app.sesame.com'); assert.equal(initial.settings.overlayPort, 48241); assert.match(initial.token, /^[a-f0-9]{64}$/);
  const character = initial.characters[0]; assert.ok(f.store.assetPath(character.id, character.closed[0].file));
  await fs.rm(f.legacy, { recursive: true }); character.name = 'Updated avatar'; character.closed[0].x = 15;
  await f.store.saveCharacter(character); await f.store.saveSettings({ ...initial.settings, mode: 'browser' });
  const restored = await new LibraryStore(path.join(f.root, 'data'), f.legacy).load();
  assert.equal(restored.token, initial.token); assert.equal(restored.characters[0].id, character.id); assert.equal(restored.characters[0].name, 'Updated avatar'); assert.equal(restored.characters[0].closed[0].x, 15); assert.equal(restored.settings.mode, 'browser');
  restored.characters[0].name = 'Attempt to mutate snapshot'; assert.equal(f.store.snapshot().characters[0].name, 'Updated avatar');
});
test('rejects invalid or cross-character asset references and malformed images before writes', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); const initial = await f.store.load(); const character = initial.characters[0];
  const stagedId = randomUUID(); const [sprite] = await f.store.importImageBuffers(stagedId, [{ name: 'Avatar.png', png }]);
  assert.ok(f.store.assetPath(stagedId, sprite.file)); assert.equal(f.store.assetPath(character.id, sprite.file), undefined); assert.equal(f.store.assetPath(stagedId, '../../library.json'), undefined);
  await assert.rejects(f.store.saveCharacter({ ...character, closed: [sprite] }), /has not been imported/);
  await assert.rejects(f.store.saveCharacter({ ...character, open: [] }), /open-mouth images/);
  await assert.rejects(f.store.importImageBuffers('../outside', [{ name: 'Avatar.png', png }]), /UUID/);
  await assert.rejects(f.store.importImageBuffers(stagedId, [{ name: 'Avatar.jpg', png: Buffer.from('not an image') }]), /PNG image/);
  const oversized = Buffer.from(png); oversized.writeUInt32BE(8193, 16); await assert.rejects(f.store.importImageBuffers(stagedId, [{ name: 'Too large.png', png: oversized }]), /limit/);
  const broken = Buffer.from(png); broken.write('FAIL', broken.length - 8); await assert.rejects(f.store.importImageBuffers(stagedId, [{ name: 'Broken.png', png: broken }]), /incomplete/);
  assert.deepEqual(f.store.snapshot(), initial);
});
test('new characters can use staged artwork; concurrent saves do not overwrite each other', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); const initial = await f.store.load(); const id = randomUUID();
  const images = await f.store.importImageBuffers(id, [{ name: 'closed.png', png }, { name: 'open.png', png }]);
  await Promise.all([f.store.saveCharacter({ id, name: 'Second character', width: 800, height: 600, frameMs: 200, closed: [images[0]], open: [images[1]] }), f.store.saveSettings({ ...initial.settings, mode: 'browser' })]);
  const restored = await new LibraryStore(path.join(f.root, 'data'), f.legacy).load(); assert.equal(restored.characters.length, 2); assert.equal(restored.settings.mode, 'browser');
});
test('corrupt or unsupported configuration is preserved and reported rather than replaced', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); await f.store.load(); const original = '{"version":999,"broken":true}'; await fs.writeFile(f.store.filename, original);
  await assert.rejects(new LibraryStore(path.join(f.root, 'data'), f.legacy).load(), /original file was preserved/);
  assert.equal(await fs.readFile(f.store.filename, 'utf8'), original); assert.ok((await fs.readdir(path.dirname(f.store.filename))).some(name => name.includes('.invalid-')));
});
test('validates detector hysteresis, saved ports and unsupported schema fields', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true })); const initial = await f.store.load();
  await assert.rejects(f.store.saveSettings({ ...initial.settings, detector: { ...initial.settings.detector, closeThresholdDb: -20 } }), /lower than open/);
  await assert.rejects(f.store.saveSettings({ ...initial.settings, overlayPort: 80 }), /Overlay port/);
  await assert.rejects(f.store.saveSettings({ ...initial.settings, assistantUrl: 'file:///C:/private' }), /HTTPS or HTTP/);
  await assert.rejects(f.store.saveCharacter({ ...initial.characters[0], unknown: 'unsupported' } as never), /unsupported or missing/);
});
