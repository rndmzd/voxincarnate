import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { addMotionChoices, defaultMotion, generatedMotionChoices, hasMotion, missingMotionSelection, motionChoices, selectMotion, validateMotionSelection } from '../character-motions.js';
import { characterSprites, type Character } from '../shared.js';

function character(): Character {
  const sprite = () => ({ id: randomUUID(), file: `${randomUUID()}.png`, name: 'Frame', x: 0, y: 0, scale: 1 });
  return { id: randomUUID(), name: 'Existing character', width: 600, height: 600, frameMs: 180, closed: [sprite()], open: [sprite()],
    motions: { enter: { ...defaultMotion('walk', 'left'), frames: [sprite()], durationMs: 2300, frameMs: 160, facing: 'left' } } };
}

test('switching away from a legacy walk and back preserves its artwork, alignment, direction and timing', () => {
  const original = character(); delete original.motions!.enter!.effect;
  original.motions!.enter!.frames[0].x = 42;
  let edited = selectMotion(original, 'enter', 'smoke');
  edited.motions!.enter!.durationMs = 900;
  edited = selectMotion(edited, 'enter', 'fall-jump');
  edited.motions!.enter!.durationMs = 1400;
  edited = selectMotion(edited, 'enter', 'walk');
  assert.deepEqual(edited.motions!.enter, original.motions!.enter);
  assert.equal(motionChoices(edited, 'enter').smoke!.durationMs, 900);
  assert.equal(motionChoices(edited, 'enter')['fall-jump']!.durationMs, 1400);
  assert.deepEqual(characterSprites(edited), characterSprites(original));
  assert.equal(new Set(characterSprites(edited).map(sprite => sprite.id)).size, characterSprites(edited).length);
  assert.equal(original.motionVariants, undefined);
  const hidden = selectMotion(edited, 'enter');
  assert.equal(hidden.motions!.enter, undefined); assert.equal(hasMotion(hidden, 'enter', 'walk'), true);
  assert.deepEqual(selectMotion(hidden, 'enter', 'walk').motions!.enter, original.motions!.enter);
});

test('adding a mixture of new choices retains speech, sounds, active clips and previously generated variants', () => {
  const original = character();
  original.motionSounds = { smoke: { file: `${randomUUID()}.wav`, name: 'Custom sound' } };
  const originalCopy = structuredClone(original);
  const selection = { enter: ['smoke', 'fall-jump'] as const, exit: ['fall-jump'] as const };
  const choices = generatedMotionChoices({ enter: [...selection.enter], exit: [...selection.exit] }, {}, 'left', 'right');
  const added = addMotionChoices(original, choices);
  assert.deepEqual(added.motions!.enter, original.motions!.enter);
  assert.equal(added.motions!.exit!.effect, 'fall-jump');
  assert.deepEqual(added.closed, original.closed); assert.deepEqual(added.open, original.open); assert.deepEqual(added.motionSounds, original.motionSounds);
  for (const effect of ['walk', 'smoke', 'fall-jump'] as const) assert.equal(hasMotion(added, 'enter', effect), true);
  assert.equal(hasMotion(added, 'exit', 'walk'), false);
  assert.deepEqual(original, originalCopy);
  const repeated = addMotionChoices(added, { enter: { walk: defaultMotion('walk'), smoke: { ...defaultMotion('smoke'), durationMs: 700 } } });
  assert.deepEqual(repeated, added);
});

test('generation rejects empty, duplicate, unsupported and already available selections before requests', () => {
  for (const invalid of [null, [], {}, { enter: [], exit: [] }, { enter: ['dance'], exit: [] }, { enter: ['walk', 'walk'], exit: [] }, { enter: [], exit: [], extra: true }]) {
    assert.throws(() => validateMotionSelection(invalid));
  }
  assert.doesNotThrow(() => validateMotionSelection({ enter: ['smoke', 'walk'], exit: [] }));
  assert.throws(() => validateMotionSelection({ enter: ['smoke'], exit: [] }, true), /at least one entrance and one exit/);
  const existing = character();
  assert.throws(() => missingMotionSelection(existing, { enter: ['walk'], exit: ['walk'] }), /already has/);
  assert.doesNotThrow(() => missingMotionSelection(existing, { enter: ['smoke'], exit: ['walk'] }));
});
