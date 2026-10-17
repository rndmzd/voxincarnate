import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createMotionAnimator, type MotionStart } from '../animation';
import { createMotionSoundPlayer } from '../motion-sound';
import { validateWav } from '../wav';
import type { Character, MotionEffect } from '../shared';

const avatar: Character = { id: 'character', name: 'Test', width: 600, height: 600, frameMs: 100,
  closed: [{ id: 'rest', file: 'rest.png', name: 'rest', x: 0, y: 0, scale: 1 }], open: [],
  motionSounds: { walk: { file: 'steps.wav', name: 'Steps' }, smoke: { file: 'puff.wav', name: 'Puff' }, 'fall-jump': { file: 'jump.wav', name: 'Jump' } } };

function harness(failure = false) {
  const audios: Array<{ src: string; currentTime: number; paused: boolean; plays: number; reject?: (error: Error) => void }> = [];
  const timers = new Map<number, { callback: () => void; duration: number }>();
  const errors: string[] = []; let nextTimer = 0;
  class AudioFixture {
    currentTime = 0; paused = true; plays = 0; reject?: (error: Error) => void;
    constructor(public src: string) { audios.push(this); }
    pause() { this.paused = true; }
    play() { this.paused = false; this.plays++; return failure ? new Promise<void>((_, reject) => { this.reject = reject; }) : Promise.resolve(); }
  }
  const factory = vm.runInNewContext(`(${createMotionSoundPlayer.toString()})`, {
    Audio: AudioFixture,
    setTimeout: (callback: () => void, duration: number) => { const id = ++nextTimer; timers.set(id, { callback, duration }); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  }) as typeof createMotionSoundPlayer;
  const player = factory((id, sound) => `/assets/${id}/${sound.file}`, undefined, error => errors.push(error));
  return { player, audios, timers, errors };
}

test('each effect shares one sound for entrance and exit, and stale frames cannot replay it', () => {
  for (const effect of ['walk', 'smoke', 'fall-jump'] as MotionEffect[]) {
    const h = harness(); const animator = createMotionAnimator();
    const clip = { frames: effect === 'walk' ? avatar.closed : [], effect, frameMs: 100, durationMs: 1000, side: 'right' as const };
    const character = { ...avatar, motions: { enter: clip, exit: clip } };
    animator.update(character, { visible: true, sequence: 0 }, 0);
    h.player.baseline(character.id);
    const entrance = animator.update(character, { visible: true, sequence: 1 }, 100);
    h.player.play(character, entrance); h.player.play(character, entrance);
    h.player.play(character, animator.update(character, { visible: true, sequence: 1 }, 110));
    assert.equal(h.audios.length, 1); assert.equal(h.audios[0].plays, 1);
    animator.frame(1100);
    const exit = animator.update(character, { visible: false, sequence: 2 }, 1200);
    h.player.play(character, exit);
    assert.equal(h.audios.length, 2); assert.equal(h.audios[0].src, h.audios[1].src);
    assert.equal(h.audios[0].paused, true); assert.equal(h.audios[0].currentTime, 0);
    assert.equal(h.timers.size, 1); assert.equal([...h.timers.values()][0].duration, exit!.durationMs);
    [...h.timers.values()][0].callback(); assert.equal(h.audios[1].paused, true);
  }
});

test('sounds are optional and absent/invalid/hidden-exit animations produce no sound start', () => {
  const h = harness(); const animator = createMotionAnimator();
  h.player.play({ ...avatar, motionSounds: {} }, { effect: 'smoke', sequence: 1, durationMs: 1000 });
  h.player.play(avatar, animator.update(avatar, { visible: true, sequence: 1 }, 0));
  const character = { ...avatar, motions: { exit: { frames: [], effect: 'smoke' as const, frameMs: 100, durationMs: 1000, side: 'right' as const } } };
  animator.update(character, { visible: false, sequence: 2 }, 10); animator.frame(1010);
  h.player.play(character, animator.update(character, { visible: false, sequence: 3 }, 1100));
  assert.equal(h.audios.length, 0);
});

test('a new effect interrupts playback, and a reconnect baseline suppresses historical sounds', () => {
  const h = harness();
  h.player.baseline(avatar.id, 7);
  h.player.play(avatar, { effect: 'smoke', sequence: 7, durationMs: 1000 }); assert.equal(h.audios.length, 0);
  h.player.play(avatar, { effect: 'smoke', sequence: 8, durationMs: 1000 });
  h.player.play(avatar, { effect: 'walk', sequence: 9, durationMs: 500 });
  assert.equal(h.audios[0].paused, true); assert.equal(h.audios[1].paused, false);
  h.player.baseline(avatar.id, 10); assert.equal(h.audios[1].paused, true); assert.equal(h.timers.size, 0);
  h.player.play(avatar, { effect: 'walk', sequence: 10, durationMs: 500 }); assert.equal(h.audios.length, 2);
  h.player.play({ ...avatar, id: 'other' }, { effect: 'walk', sequence: 1, durationMs: 500 }); assert.equal(h.audios.length, 3);
});

test('a rejected play reports a useful error without breaking animation, and ignores cancelled failures', async () => {
  const h = harness(true);
  const start: MotionStart = { effect: 'smoke', sequence: 1, durationMs: 1000 };
  assert.doesNotThrow(() => h.player.play(avatar, start));
  h.player.play(avatar, { ...start, sequence: 2 });
  h.audios[0].reject!(new Error('Interrupted')); await Promise.resolve(); assert.equal(h.errors.length, 0);
  h.audios[1].reject!(new Error('Autoplay blocked')); await Promise.resolve();
  assert.match(h.errors[0], /Could not play Puff/); assert.equal(h.audios[1].paused, true); assert.equal(h.timers.size, 0);
});

test('supplied WAV effects validate, while malformed, unsupported and oversized audio is rejected', async () => {
  for (const name of ['puff_of_smoke', 'footsteps']) {
    const bytes = await readFile(new URL(`../../sounds/${name}.wav`, import.meta.url));
    assert.doesNotThrow(() => validateWav(bytes));
    assert.throws(() => validateWav(bytes.subarray(0, -1)), /complete/);
    const compressed = Buffer.from(bytes); compressed.writeUInt16LE(17, 20);
    assert.throws(() => validateWav(compressed), /PCM/);
    const invalidRate = Buffer.from(bytes); invalidRate.writeUInt32LE(1, 24);
    assert.throws(() => validateWav(invalidRate), /PCM/);
  }
  assert.throws(() => validateWav(Buffer.from('not audio')), /WAV/);
  assert.throws(() => validateWav(Buffer.alloc(16 * 1024 * 1024 + 1)), /16 MB/);
});
