import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LibraryStore, validateCharacter } from '../library.js';
import { VISEMES, characterSprites, type Character, type MotionClip } from '../shared.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vox-library-')); const legacy = path.join(root, 'legacy');
  for (const pose of ['closed', 'open']) { await fs.mkdir(path.join(legacy, `mouth_${pose}`), { recursive: true }); await fs.writeFile(path.join(legacy, `mouth_${pose}`, '1.png'), png); }
  const store = new LibraryStore(path.join(root, 'data'), legacy); return { root, legacy, store };
}
async function addCharacter(store: LibraryStore, name = 'Second character'): Promise<Character> {
  const id = randomUUID();
  const sprites = await store.importImageBuffers(id, [{ name: 'closed.png', png }, { name: 'open.png', png }]);
  const character: Character = { id, name, width: 600, height: 600, frameMs: 180, closed: [sprites[0]], open: [sprites[1]] };
  await store.saveCharacter(character);
  return character;
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

test('migrates a v1 library only after validating artwork and retains the exact original backup', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load();
  const original = JSON.stringify({ ...initial, version: 1 }, null, 2) + '\n';
  await fs.writeFile(f.store.filename, original);
  const restored = await new LibraryStore(path.join(f.root, 'data'), f.legacy).load();
  assert.equal(restored.version, 2);
  assert.deepEqual(restored, initial);
  assert.equal(await fs.readFile(`${f.store.filename}.v1.bak`, 'utf8'), original);
  assert.equal(JSON.parse(await fs.readFile(f.store.filename, 'utf8')).version, 2);
  await new LibraryStore(path.join(f.root, 'data'), f.legacy).load();
  assert.equal(await fs.readFile(`${f.store.filename}.v1.bak`, 'utf8'), original);
  const later = JSON.stringify({ ...initial, version: 1, characters: [{ ...initial.characters[0], name: 'Later v1 edit' }] });
  await fs.writeFile(f.store.filename, later);
  const edited = await new LibraryStore(path.join(f.root, 'data'), f.legacy).load();
  assert.equal(edited.characters[0].name, 'Later v1 edit');
  const preserved = (await fs.readdir(path.dirname(f.store.filename))).filter(name => name.startsWith('library.json.v1-'));
  assert.equal(preserved.length, 1);
  assert.equal(await fs.readFile(path.join(path.dirname(f.store.filename), preserved[0]), 'utf8'), later);
  assert.equal(await fs.readFile(`${f.store.filename}.v1.bak`, 'utf8'), original);
});

test('retains managed viseme artwork and animation mode across restart, with partial maps allowed', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const library = await f.store.load(); const character = library.characters[0];
  const [sprite] = await f.store.importImageBuffers(character.id, [{ name: 'A.png', png }]);
  await f.store.saveCharacter({ ...character, animationMode: 'viseme', visemes: { A: [sprite] } });
  const restarted = new LibraryStore(path.join(f.root, 'data'), f.legacy);
  const restored = await restarted.load();
  assert.equal(restored.characters[0].animationMode, 'viseme');
  assert.deepEqual(restored.characters[0].visemes?.A, [sprite]);
  assert.ok(restarted.assetPath(character.id, sprite.file));
  await assert.rejects(f.store.saveCharacter({ ...character, visemes: { A: [] } }), /A-mouth images/);
  await assert.rejects(f.store.saveCharacter({ ...character, visemes: { bad: [sprite] } } as never), /unsupported/);
  await assert.rejects(f.store.saveCharacter({ ...character, visemes: { A: [{ ...sprite, scale: NaN }] } }), /Image scale/);
  await assert.rejects(f.store.saveCharacter({ ...character, animationMode: 'unknown' } as never), /animation/);
});

test('adds the nine-pose demo only on request and preserves existing characters', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load();
  const result = await f.store.createVisemeDemo(path.resolve('artwork/viseme-demo'));
  assert.equal(result.characters.length, 2); assert.deepEqual(result.characters[0], initial.characters[0]);
  const demo = result.characters[1];
  assert.equal(demo.animationMode, 'viseme'); assert.equal(result.settings.activeCharacterId, demo.id);
  assert.equal(Object.keys(demo.visemes ?? {}).length, 9);
  const restored = await new LibraryStore(path.join(f.root, 'data'), f.legacy).load();
  assert.deepEqual(restored.characters[1], demo); assert.equal(restored.token, initial.token);
});

test('persists a staged suite with all mouth poses and both walking clips through restart', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const id = randomUUID();
  const names = ['closed', 'open', ...VISEMES, 'enter-1', 'enter-2', 'exit-1', 'exit-2'];
  const images = await f.store.importImageBuffers(id, names.map(name => ({ name: `${name}.png`, png })));
  const generated: Character = {
    id, name: 'Generated suite', width: 1024, height: 1024, frameMs: 120,
    closed: [images[0]], open: [images[1]], animationMode: 'viseme',
    visemes: Object.fromEntries(VISEMES.map((pose, index) => [pose, [images[index + 2]]])),
    motions: {
      enter: { frames: images.slice(11, 13), frameMs: 100, durationMs: 1800, side: 'left', effect: 'walk', facing: 'right' },
      exit: { frames: images.slice(13, 15), frameMs: 160, durationMs: 2400, side: 'right', effect: 'walk', facing: 'left' }
    }
  };
  const saved = await f.store.saveCharacter(generated);
  assert.equal(saved.version, 2); assert.deepEqual(saved.characters[0], initial.characters[0]);
  const restarted = new LibraryStore(path.join(f.root, 'data'), f.legacy);
  const restored = await restarted.load();
  assert.deepEqual(restored.characters[1], generated); assert.equal(restored.token, initial.token);
  for (const sprite of characterSprites(generated)) assert.ok(restarted.assetPath(id, sprite.file));
  restored.characters[1].motions!.enter!.frames[0].x = 900;
  assert.equal(restarted.snapshot().characters[1].motions?.enter?.frames[0].x, 0);
});

test('persists local smoke and fall-jump effects without motion assets and leaves legacy clip metadata unchanged on load', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const character = initial.characters[0];
  const legacyClip: MotionClip = { frames: [{ ...character.closed[0], id: randomUUID() }], frameMs: 120, durationMs: 1600, side: 'left' };
  await f.store.saveCharacter({ ...character, motions: { enter: legacyClip } });
  const original = await fs.readFile(f.store.filename, 'utf8');
  const restarted = new LibraryStore(path.join(f.root, 'data'), f.legacy);
  const restored = await restarted.load();
  assert.deepEqual(restored.characters[0].motions?.enter, legacyClip);
  assert.equal(Object.hasOwn(restored.characters[0].motions!.enter!, 'effect'), false);
  assert.equal(Object.hasOwn(restored.characters[0].motions!.enter!, 'facing'), false);
  assert.equal(await fs.readFile(f.store.filename, 'utf8'), original);
  const effects: Character = { ...character, motions: {
    enter: { frames: [], frameMs: 40, durationMs: 200, side: 'right', effect: 'smoke', facing: 'left' },
    exit: { frames: [], frameMs: 10000, durationMs: 20000, side: 'left', effect: 'fall-jump', facing: 'right' }
  } };
  await restarted.saveCharacter(effects);
  const saved = await fs.readFile(f.store.filename, 'utf8');
  const reopened = await new LibraryStore(path.join(f.root, 'data'), f.legacy).load();
  assert.deepEqual(reopened.characters[0], effects);
  assert.deepEqual(characterSprites(reopened.characters[0]), [...character.closed, ...character.open]);
  assert.equal(await fs.readFile(f.store.filename, 'utf8'), saved);
});

test('validates optional walking clips, timing bounds, strict fields and frame counts', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const character = (await f.store.load()).characters[0];
  const frame = { ...character.closed[0], id: randomUUID() };
  const clip: MotionClip = { frames: [frame], frameMs: 40, durationMs: 200, side: 'left' };
  assert.doesNotThrow(() => validateCharacter({ ...character, motions: {} }));
  assert.doesNotThrow(() => validateCharacter({ ...character, motions: { enter: clip } }));
  assert.doesNotThrow(() => validateCharacter({ ...character, motions: { exit: { ...clip, frameMs: 10000, durationMs: 20000, side: 'right' } } }));
  assert.doesNotThrow(() => validateCharacter({ ...character, motions: { enter: { ...clip, frames: Array.from({ length: 64 }, () => ({ ...frame, id: randomUUID() })) } } }));
  const invalid: Array<[unknown, RegExp]> = [
    [null, /Walking animations must be an object/],
    [{ dance: clip }, /unsupported/],
    [{ enter: null }, /enter animation must be an object/],
    [{ enter: { ...clip, extra: true } }, /unsupported/],
    [{ enter: { frames: [frame], frameMs: 40, side: 'left' } }, /missing/],
    [{ enter: { ...clip, frameMs: 39 } }, /frame duration/],
    [{ enter: { ...clip, frameMs: 10001 } }, /frame duration/],
    [{ enter: { ...clip, frameMs: 40.5 } }, /frame duration/],
    [{ enter: { ...clip, durationMs: 199 } }, /animation duration/],
    [{ enter: { ...clip, durationMs: 20001 } }, /animation duration/],
    [{ enter: { ...clip, durationMs: Infinity } }, /animation duration/],
    [{ enter: { ...clip, side: 'up' } }, /side/],
    [{ enter: { ...clip, effect: 'unknown' } }, /effect/],
    [{ enter: { ...clip, effect: undefined } }, /effect/],
    [{ enter: { ...clip, effect: null } }, /effect/],
    [{ enter: { ...clip, facing: 'up' } }, /facing/],
    [{ enter: { ...clip, facing: undefined } }, /facing/],
    [{ enter: { ...clip, facing: null } }, /facing/],
    [{ enter: { ...clip, frames: [] } }, /enter animation frames/],
    [{ enter: { ...clip, frames: [], effect: 'walk' } }, /enter animation frames/],
    [{ enter: { ...clip, frames: Array.from({ length: 65 }, () => ({ ...frame, id: randomUUID() })) } }, /enter animation frames/],
    [{ exit: { ...clip, frames: [{ ...frame, file: '../outside.png' }] } }, /asset filename/],
    [{ exit: { ...clip, frames: [{ ...frame, scale: NaN }] } }, /Image scale/]
  ];
  for (const [motions, error] of invalid) assert.throws(() => validateCharacter({ ...character, motions }), error);
});

test('local effects accept zero through 64 frames while retaining timing, side and sprite validation', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const character = (await f.store.load()).characters[0];
  const frame = { ...character.closed[0], id: randomUUID() };
  for (const effect of ['smoke', 'fall-jump'] as const) {
    const clip: MotionClip = { frames: [], frameMs: 40, durationMs: 200, side: 'left', effect, facing: 'left' };
    assert.doesNotThrow(() => validateCharacter({ ...character, motions: { enter: clip } }));
    assert.doesNotThrow(() => validateCharacter({ ...character, motions: { exit: { ...clip, frames: Array.from({ length: 64 }, () => ({ ...frame, id: randomUUID() })), frameMs: 10000, durationMs: 20000, side: 'right', facing: 'right' } } }));
    const invalid: Array<[unknown, RegExp]> = [
      [{ ...clip, frames: null }, /animation frames/],
      [{ ...clip, frames: {} }, /animation frames/],
      [{ ...clip, frames: undefined }, /animation frames/],
      [{ ...clip, frames: Array.from({ length: 65 }, () => ({ ...frame, id: randomUUID() })) }, /animation frames/],
      [{ ...clip, frameMs: 39 }, /frame duration/],
      [{ ...clip, frameMs: 10001 }, /frame duration/],
      [{ ...clip, frameMs: 40.5 }, /frame duration/],
      [{ ...clip, durationMs: 199 }, /animation duration/],
      [{ ...clip, durationMs: 20001 }, /animation duration/],
      [{ ...clip, durationMs: NaN }, /animation duration/],
      [{ ...clip, side: 'top' }, /side/],
      [{ ...clip, facing: 'top' }, /facing/],
      [{ ...clip, frames: [{ ...frame, file: '../outside.png' }] }, /asset filename/],
      [{ ...clip, frames: [{ ...frame, scale: 0 }] }, /Image scale/],
      [{ ...clip, extra: true }, /unsupported/]
    ];
    for (const [invalidClip, error] of invalid) assert.throws(() => validateCharacter({ ...character, motions: { exit: invalidClip } }), error);
  }
});

test('sprite IDs stay unique across mouth and walking channels while aligned fallback copies may share a file', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const character = (await f.store.load()).characters[0];
  const frame = { ...character.closed[0], id: randomUUID() };
  const clip: MotionClip = { frames: [frame], frameMs: 120, durationMs: 1600, side: 'left' };
  await assert.rejects(f.store.saveCharacter({ ...character, motions: { enter: { ...clip, frames: [character.closed[0]] } } }), /unique UUIDs/);
  await assert.rejects(f.store.saveCharacter({ ...character, visemes: { A: [frame] }, motions: { enter: clip } }), /unique UUIDs/);
  await assert.rejects(f.store.saveCharacter({ ...character, motions: { enter: clip, exit: { ...clip, frames: [{ ...frame, id: frame.id.toUpperCase() }] } } }), /unique UUIDs/);
  const saved = await f.store.saveCharacter({ ...character, motions: { enter: clip, exit: { ...clip, frames: [{ ...frame, id: randomUUID() }] } } });
  assert.equal(saved.characters[0].motions?.enter?.frames[0].file, character.closed[0].file);
});

test('walking clips cannot reference another character staging area or missing managed files', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const character = initial.characters[0]; const stagedId = randomUUID();
  const [foreign] = await f.store.importImageBuffers(stagedId, [{ name: 'walk.png', png }]);
  const clip: MotionClip = { frames: [foreign], frameMs: 100, durationMs: 1800, side: 'left' };
  for (const effect of ['walk', 'smoke', 'fall-jump'] as const) await assert.rejects(f.store.saveCharacter({ ...character, motions: { enter: { ...clip, effect } } }), /has not been imported/);
  const [own] = await f.store.importImageBuffers(character.id, [{ name: 'own-walk.png', png }]);
  await f.store.saveCharacter({ ...character, motions: { exit: { ...clip, effect: 'fall-jump', facing: 'right', frames: [own] } } });
  await fs.rm(f.store.assetPath(character.id, own.file)!);
  const original = await fs.readFile(f.store.filename, 'utf8');
  await assert.rejects(new LibraryStore(path.join(f.root, 'data'), f.legacy).load(), /original file was preserved/);
  assert.equal(await fs.readFile(f.store.filename, 'utf8'), original);
});

test('discarding failed generation removes only an unsaved draft and rejects saved character IDs', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const saved = initial.characters[0];
  const draftId = randomUUID(), retainedId = randomUUID();
  const [draft] = await f.store.importImageBuffers(draftId, [{ name: 'incomplete.png', png }]);
  const [retained] = await f.store.importImageBuffers(retainedId, [{ name: 'another-draft.png', png }]);
  const draftPath = f.store.assetPath(draftId, draft.file)!;
  await assert.rejects(f.store.discardCharacterDraft(saved.id), /Saved character artwork/);
  await assert.rejects(f.store.discardCharacterDraft('../outside'), /UUID/);
  await f.store.discardCharacterDraft(draftId);
  assert.equal(f.store.assetPath(draftId, draft.file), undefined);
  await assert.rejects(fs.stat(draftPath), { code: 'ENOENT' });
  assert.ok(f.store.assetPath(retainedId, retained.file));
  assert.ok(f.store.assetPath(saved.id, saved.closed[0].file));
  assert.deepEqual(f.store.snapshot(), initial);
  await f.store.discardCharacterDraft(draftId);
});

test('renames active and inactive characters without changing artwork, IDs, animation or settings, and persists through restart', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const second = await addCharacter(f.store);
  const [viseme, entrance] = await f.store.importImageBuffers(second.id, [{ name: 'A.png', png }, { name: 'enter.png', png }]);
  await f.store.saveCharacter({ ...second, width: 800, frameMs: 120, animationMode: 'viseme', visemes: { A: [viseme] }, motions: { enter: { frames: [entrance], frameMs: 150, durationMs: 2000, side: 'left' } } });
  await f.store.saveSettings({ ...initial.settings, mode: 'browser', inputId: 'microphone', detector: { ...initial.settings.detector, gain: 2 } });
  const before = f.store.snapshot(); const assetPaths = before.characters.flatMap(character => characterSprites(character).map(sprite => f.store.assetPath(character.id, sprite.file)!));
  const assetContents = await Promise.all(assetPaths.map(filename => fs.readFile(filename)));
  const inactive = await f.store.renameCharacter(second.id, '  Renamed inactive · 信号  ');
  const expected = structuredClone(before); expected.characters[1].name = 'Renamed inactive · 信号';
  assert.deepEqual(inactive, expected); assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), expected);
  const active = await f.store.renameCharacter(initial.characters[0].id, 'Renamed active');
  expected.characters[0].name = 'Renamed active';
  assert.deepEqual(active, expected); assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), expected);
  assert.deepEqual(await Promise.all(assetPaths.map(filename => fs.readFile(filename))), assetContents);
  active.characters[0].name = 'Snapshot mutation'; assert.equal(f.store.snapshot().characters[0].name, 'Renamed active');
});

test('rejects malformed or missing rename targets and invalid names without changing saved data or artwork', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const saved = initial.characters[0]; const original = await fs.readFile(f.store.filename, 'utf8');
  for (const id of ['../outside', '', undefined, [saved.id]]) await assert.rejects(f.store.renameCharacter(id as never, 'New name'), /UUID/);
  await assert.rejects(f.store.renameCharacter(randomUUID(), 'New name'), /does not exist/);
  for (const name of ['', '   ', undefined, null, 42, ['Name'], 'x'.repeat(121), 'Line\nbreak', 'Tab\tname', 'Null\u0000name']) {
    await assert.rejects(f.store.renameCharacter(saved.id, name as never), /Character name is invalid/);
  }
  assert.deepEqual(f.store.snapshot(), initial); assert.equal(await fs.readFile(f.store.filename, 'utf8'), original);
  for (const sprite of characterSprites(saved)) assert.ok(f.store.assetPath(saved.id, sprite.file));
  const renamed = await f.store.renameCharacter(saved.id, 'x'.repeat(120));
  assert.equal(renamed.characters[0].name.length, 120); assert.deepEqual(renamed.settings, initial.settings);
});

test('serializes renames with concurrent character and settings saves so names and other edits are retained', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const second = await addCharacter(f.store);
  const edited = structuredClone(initial.characters[0]); edited.closed[0].x = 27; edited.height = 700;
  await Promise.all([
    f.store.saveCharacter(edited),
    f.store.renameCharacter(edited.id, 'Active renamed'),
    f.store.renameCharacter(second.id, 'Inactive renamed'),
    f.store.saveSettings({ ...initial.settings, mode: 'browser' })
  ]);
  const saved = f.store.snapshot(); assert.deepEqual(saved.characters, [{ ...edited, name: 'Active renamed' }, { ...second, name: 'Inactive renamed' }]);
  assert.deepEqual(saved.settings, { ...initial.settings, mode: 'browser' });
  assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), saved);
});

test('a failed rename commit leaves the saved name and artwork intact and can be retried', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const before = await f.store.load(); const character = before.characters[0]; const original = await fs.readFile(f.store.filename, 'utf8');
  const rename = t.mock.method(fs, 'rename', async () => { throw new Error('Library write failed'); });
  await assert.rejects(f.store.renameCharacter(character.id, 'New name'), /Library write failed/);
  assert.deepEqual(f.store.snapshot(), before); assert.equal(await fs.readFile(f.store.filename, 'utf8'), original);
  assert.ok(!(await fs.readdir(f.store.dataDir)).some(name => name.endsWith('.tmp')));
  for (const sprite of characterSprites(character)) assert.ok(f.store.assetPath(character.id, sprite.file));
  assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), before);
  rename.mock.restore();
  const saved = await f.store.renameCharacter(character.id, 'New name'); assert.equal(saved.characters[0].name, 'New name');
  assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), saved);
});

test('deletes an inactive character and all its imported artwork while retaining other characters and drafts', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const removed = await addCharacter(f.store);
  const [unused] = await f.store.importImageBuffers(removed.id, [{ name: 'unused.png', png }]);
  const draftId = randomUUID(); const [draft] = await f.store.importImageBuffers(draftId, [{ name: 'draft.png', png }]);
  const characterDir = path.join(f.store.dataDir, 'characters', removed.id);
  const outside = path.join(f.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(characterDir, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir');
  const deleted = await f.store.deleteCharacter(removed.id);
  assert.deepEqual(deleted, initial);
  for (const sprite of [...characterSprites(removed), unused]) assert.equal(f.store.assetPath(removed.id, sprite.file), undefined);
  await assert.rejects(fs.stat(characterDir), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(f.store.assetPath(draftId, draft.file));
  assert.ok(f.store.assetPath(initial.characters[0].id, initial.characters[0].closed[0].file));
  const restarted = new LibraryStore(f.store.dataDir, f.legacy);
  assert.deepEqual(await restarted.load(), initial);
  assert.equal(restarted.assetPath(removed.id, removed.closed[0].file), undefined);
});

test('deleting the active character selects the first remaining character and preserves every other setting', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const removed = await addCharacter(f.store); const third = await addCharacter(f.store, 'Third character');
  const settings = { ...initial.settings, activeCharacterId: removed.id, mode: 'browser' as const, inputId: 'microphone', browserInputId: 'assistant', assistantUrl: 'https://example.com', overlayPort: 49241, detector: { ...initial.settings.detector, gain: 2 } };
  await f.store.saveSettings(settings);
  const deleted = await f.store.deleteCharacter(removed.id);
  assert.deepEqual(deleted.characters, [initial.characters[0], third]);
  assert.deepEqual(deleted.settings, { ...settings, activeCharacterId: initial.characters[0].id });
  assert.equal(deleted.token, initial.token); assert.equal(deleted.version, initial.version);
  assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), deleted);
});

test('rejects malformed, missing and last-character deletions without changing saved data or artwork', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const saved = initial.characters[0]; const original = await fs.readFile(f.store.filename, 'utf8');
  for (const id of ['../outside', '', undefined, [saved.id]]) await assert.rejects(f.store.deleteCharacter(id as never), /UUID/);
  await assert.rejects(f.store.deleteCharacter(randomUUID()), /does not exist/);
  await assert.rejects(f.store.deleteCharacter(saved.id), /at least one character/);
  assert.deepEqual(f.store.snapshot(), initial);
  assert.equal(await fs.readFile(f.store.filename, 'utf8'), original);
  assert.ok(f.store.assetPath(saved.id, saved.closed[0].file));
});

test('serializes simultaneous deletions so both removals persist and the last character remains protected', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const second = await addCharacter(f.store); const third = await addCharacter(f.store, 'Third character');
  await f.store.saveSettings({ ...initial.settings, activeCharacterId: second.id });
  await Promise.all([f.store.deleteCharacter(initial.characters[0].id), f.store.deleteCharacter(second.id)]);
  const remaining = f.store.snapshot(); assert.deepEqual(remaining.characters, [third]); assert.equal(remaining.settings.activeCharacterId, third.id);
  assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), remaining);
  const attempts = await Promise.allSettled([f.store.deleteCharacter(third.id), f.store.deleteCharacter(third.id)]);
  assert.ok(attempts.every(result => result.status === 'rejected' && /at least one character/.test(result.reason.message)));
  assert.ok(f.store.assetPath(third.id, third.closed[0].file));
});

test('a failed library commit leaves the character and its artwork intact and the operation can be retried', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  await f.store.load(); const removed = await addCharacter(f.store); const before = f.store.snapshot();
  const original = await fs.readFile(f.store.filename, 'utf8'); const rename = t.mock.method(fs, 'rename', async () => { throw new Error('Library write failed'); });
  await assert.rejects(f.store.deleteCharacter(removed.id), /Library write failed/);
  assert.deepEqual(f.store.snapshot(), before); assert.equal(await fs.readFile(f.store.filename, 'utf8'), original);
  for (const sprite of characterSprites(removed)) assert.ok(f.store.assetPath(removed.id, sprite.file));
  assert.deepEqual(await new LibraryStore(f.store.dataDir, f.legacy).load(), before);
  rename.mock.restore();
  assert.equal((await f.store.deleteCharacter(removed.id)).characters.length, 1);
});

test('artwork cleanup failure still returns the committed deletion and revokes every imported asset', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const removed = await addCharacter(f.store);
  const [unused] = await f.store.importImageBuffers(removed.id, [{ name: 'unused.png', png }]);
  const characterDir = path.join(f.store.dataDir, 'characters', removed.id); const originalRm = fs.rm;
  t.mock.method(fs, 'rm', async (filename: Parameters<typeof fs.rm>[0], options: Parameters<typeof fs.rm>[1]) => {
    if (String(filename) === characterDir) throw new Error('Artwork is locked');
    return originalRm(filename, options);
  });
  const warning = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.store.deleteCharacter(removed.id), initial);
  assert.equal(warning.mock.calls.length, 1);
  for (const sprite of [...characterSprites(removed), unused]) assert.equal(f.store.assetPath(removed.id, sprite.file), undefined);
  assert.ok((await fs.stat(characterDir)).isDirectory());
  const restarted = new LibraryStore(f.store.dataDir, f.legacy);
  assert.deepEqual(await restarted.load(), initial); assert.equal(restarted.assetPath(removed.id, unused.file), undefined);
});

test('commits deletion without traversing a linked characters directory during artwork cleanup', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.root, { recursive: true, force: true }));
  const initial = await f.store.load(); const removed = await addCharacter(f.store);
  const charactersDir = path.join(f.store.dataDir, 'characters'); const outside = path.join(f.root, 'outside');
  await fs.rename(charactersDir, outside);
  await fs.symlink(outside, charactersDir, process.platform === 'win32' ? 'junction' : 'dir');
  const warning = t.mock.method(console, 'warn', () => {});
  assert.deepEqual(await f.store.deleteCharacter(removed.id), initial);
  assert.equal(warning.mock.calls.length, 1);
  assert.ok((await fs.stat(path.join(outside, removed.id, 'assets', removed.closed[0].file))).isFile());
  assert.equal(f.store.assetPath(removed.id, removed.closed[0].file), undefined);
  assert.ok(f.store.assetPath(initial.characters[0].id, initial.characters[0].closed[0].file));
});
