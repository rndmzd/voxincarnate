import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createAvatarAnimator, createMotionAnimator, drawSmokePuff } from '../animation';
import type { AvatarState, Character, MotionEffect, Sprite, Viseme } from '../shared';

const sprite = (id: string): Sprite => ({ id, file: `${id}.png`, name: id, x: 0, y: 0, scale: 1 });
function character(): Character {
  return { id: 'test-character', name: 'Test', width: 600, height: 600, frameMs: 100,
    closed: [sprite('closed-1'), sprite('closed-2')], open: [sprite('open-1'), sprite('open-2')],
    animationMode: 'viseme', visemes: Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'].map(key => [key, [sprite(key)]])) };
}
function speech(weights?: Partial<Record<Viseme, number>>, running = true): Pick<AvatarState, 'running' | 'speaking' | 'articulation'> {
  return { running, speaking: running, ...(weights ? { articulation: { audioTimeMs: 0, weights } } : {}) };
}

test('explicit commands play each saved alternative in studio and serialized OBS without changing defaults', () => {
  const avatar = character();
  const clip = (effect: MotionEffect, durationMs: number) => ({ effect, durationMs, frameMs: 100, side: 'right' as const, frames: effect === 'walk' ? [sprite('gait')] : [] });
  avatar.motions = { enter: clip('smoke', 1000), exit: clip('smoke', 1000) };
  avatar.motionVariants = { enter: { walk: clip('walk', 1600), 'fall-jump': clip('fall-jump', 800) }, exit: { walk: clip('walk', 1600), 'fall-jump': clip('fall-jump', 800) } };
  const original = structuredClone(avatar);
  for (const visible of [true, false]) for (const effect of ['walk', 'fall-jump', 'smoke'] as const) {
    const studio = createMotionAnimator();
    const obs = vm.runInNewContext(`(${createMotionAnimator.toString()})()`) as ReturnType<typeof createMotionAnimator>;
    for (const animator of [studio, obs]) animator.update(avatar, { visible: !visible, sequence: 0 }, 0);
    const command = { visible, sequence: 1, effect };
    const start = studio.update(avatar, command, 10); const obsStart = obs.update(avatar, command, 10);
    assert.equal(start?.effect, effect); assert.equal(start?.durationMs, effect === 'walk' ? 1600 : effect === 'smoke' ? 1000 : 800);
    assert.deepEqual(JSON.parse(JSON.stringify(obsStart)), start);
    const middle = studio.frame(410); assert.equal(middle.active, true);
    assert.deepEqual(JSON.parse(JSON.stringify(obs.frame(410))), middle);
    if (effect === 'walk') assert.equal(middle.sprite?.id, 'gait');
    else assert.equal(middle.sprite?.id, avatar.closed[0].id);
    if (effect === 'smoke') assert.ok(middle.smoke > 0);
    if (effect === 'fall-jump') assert.ok(middle.offsetY < 0);
    assert.equal(studio.update(avatar, command, 420), undefined, 'snapshots cannot restart a command');
    assert.equal(studio.frame(2010).visible, visible);
  }
  const defaults = createMotionAnimator(); defaults.update(avatar, { visible: true, sequence: 0 }, 0);
  assert.equal(defaults.update(avatar, { visible: false, sequence: 1 }, 10)?.effect, 'smoke');
  assert.deepEqual(avatar, original);
});

test('binary artwork uses elapsed pose time and survives late animation frames', () => {
  const avatar = character(); avatar.animationMode = 'binary';
  const animator = createAvatarAnimator();
  animator.update(avatar, speech(undefined, false), 1000);
  assert.equal(animator.frame(999)?.id, 'closed-1');
  assert.equal(animator.frame(1100)?.id, 'closed-2');
  animator.update(avatar, speech(), 1110);
  assert.equal(animator.frame(1110)?.id, 'open-1');
  assert.equal(animator.frame(1460)?.id, 'open-2');
  animator.update(avatar, speech(undefined, false), 1461);
  assert.equal(animator.frame(1461)?.id, 'closed-1');
});

test('wide openings pass through authored C while bilabial closures interrupt immediately', () => {
  const avatar = character(); const animator = createAvatarAnimator();
  animator.update(avatar, speech({ D: 1 }), 0);
  assert.equal(animator.frame(0)?.id, 'C');
  assert.equal(animator.frame(16)?.id, 'C');
  assert.equal(animator.frame(32)?.id, 'D');
  animator.update(avatar, speech({ A: 1 }), 33);
  assert.equal(animator.frame(33)?.id, 'A');
  animator.update(avatar, speech({ D: 1 }), 34);
  assert.equal(animator.frame(34)?.id, 'C');
  animator.update(avatar, speech({ A: 1 }), 35);
  assert.equal(animator.frame(35)?.id, 'A');
  assert.equal(animator.frame(100)?.id, 'A');
});

test('nonclosure visemes resist near-tie chatter and short reversals, without delaying rest', () => {
  const avatar = character(); const animator = createAvatarAnimator();
  animator.update(avatar, speech({ B: 1 }), 0); assert.equal(animator.frame(0)?.id, 'B');
  animator.update(avatar, speech({ B: 0.48, C: 0.52 }), 50); assert.equal(animator.frame(50)?.id, 'B');
  animator.update(avatar, speech({ B: 0.2, C: 0.8 }), 80); assert.equal(animator.frame(80)?.id, 'C');
  animator.update(avatar, speech({ E: 1 }), 90); assert.equal(animator.frame(90)?.id, 'C');
  assert.equal(animator.frame(120)?.id, 'E');
  animator.update(avatar, speech({ X: 1 }), 121); assert.equal(animator.frame(121)?.id, 'X');
});

test('missing viseme artwork falls back to supplied binary poses and Stop cancels transitions', () => {
  const avatar = character(); avatar.visemes = { C: [sprite('C')] };
  const animator = createAvatarAnimator();
  animator.update(avatar, speech({ E: 1 }), 0); assert.equal(animator.frame(0)?.id, 'open-1');
  animator.update(avatar, speech({ A: 1 }), 1); assert.equal(animator.frame(1)?.id, 'closed-1');
  animator.update(avatar, speech({ D: 1 }), 2); assert.equal(animator.frame(2)?.id, 'C');
  animator.update(avatar, speech({ D: 1 }, false), 3); assert.equal(animator.frame(3)?.id, 'closed-1');
  assert.equal(animator.frame(80)?.id, 'closed-1');
  animator.reset(); assert.equal(animator.frame(100), undefined);
});

test('serialized OBS factory and imported studio factory choose identical artwork', () => {
  const avatar = character(); const studio = createAvatarAnimator();
  const overlay: ReturnType<typeof createAvatarAnimator> = vm.runInNewContext(`(${createAvatarAnimator.toString()})()`);
  for (const [now, input] of [[0, speech({ X: 1 })], [10, speech({ D: 1 })], [26, speech({ D: 1 })], [42, speech({ D: 1 })], [43, speech({ A: 1 })], [60, speech({ F: 1 })], [80, speech({ F: 1 })], [90, speech({ E: 1 })], [120, speech({ E: 1 })], [121, speech(undefined, false)]] as const) {
    studio.update(avatar, input, now); overlay.update(avatar, input, now);
    assert.equal(overlay.frame(now)?.id, studio.frame(now)?.id, `frame at ${now} ms`);
  }
});

function walkingCharacter(): Character {
  return { ...character(), motions: {
    enter: { frames: [sprite('enter-1'), sprite('enter-2')], frameMs: 100, durationMs: 1000, side: 'left' },
    exit: { frames: [sprite('exit-1'), sprite('exit-2')], frameMs: 100, durationMs: 1000, side: 'right' }
  } };
}

test('walking clips loop gait on elapsed time, land at rest and remain hidden after exit', () => {
  const avatar = walkingCharacter(); const motion = createMotionAnimator();
  motion.update(avatar, { visible: true, sequence: 0 }, 1000);
  assert.deepEqual(motion.frame(1000), { offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, visible: true, active: false, smoke: 0 });
  motion.update(avatar, { visible: false, sequence: 1 }, 1010);
  assert.equal(motion.frame(1010).sprite?.id, 'exit-1');
  assert.equal(motion.frame(1360).sprite?.id, 'exit-2');
  assert.equal(motion.frame(1510).offsetX, 300);
  assert.equal(motion.frame(2010).visible, false);
  motion.update(avatar, undefined, 2100);
  assert.equal(motion.frame(2100).visible, false);
  motion.update(avatar, { visible: true, sequence: 2 }, 2200);
  assert.equal(motion.frame(2199).offsetX, -600);
  assert.equal(motion.frame(2700).offsetX, -300);
  assert.deepEqual(motion.frame(3200), { offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, visible: true, active: false, smoke: 0 });
  motion.update(avatar, { visible: false, sequence: 1 }, 3300);
  assert.equal(motion.frame(3300).visible, true);
});

test('interrupted travel reverses from the current position without jumping or restarting on snapshots', () => {
  const avatar = walkingCharacter(); const motion = createMotionAnimator();
  motion.update(avatar, { visible: false, sequence: 1 }, 0);
  assert.equal(motion.frame(400).offsetX, 240);
  motion.update(avatar, { visible: true, sequence: 2 }, 400);
  assert.equal(motion.frame(400).offsetX, 240);
  assert.equal(motion.frame(600).offsetX, 120);
  motion.update(avatar, { visible: true, sequence: 2 }, 700);
  assert.equal(motion.frame(700).offsetX, 60);
  assert.deepEqual(motion.frame(800), { offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, visible: true, active: false, smoke: 0 });
});

test('characters without walking artwork show and hide immediately; changing character and reset clear travel', () => {
  const motion = createMotionAnimator(); const avatar = character();
  motion.update(avatar, { visible: false, sequence: 0 }, 0);
  assert.equal(motion.frame(0).visible, false);
  motion.update(avatar, { visible: true, sequence: 1 }, 1);
  assert.deepEqual(motion.frame(1), { offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, visible: true, active: false, smoke: 0 });
  motion.update(walkingCharacter(), { visible: false, sequence: 2 }, 2);
  assert.equal(motion.frame(500).active, true);
  motion.update({ ...avatar, id: 'other-character' }, undefined, 501);
  assert.deepEqual(motion.frame(501), { offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, visible: true, active: false, smoke: 0 });
  motion.update(avatar, { visible: false, sequence: 1 }, 502);
  motion.reset();
  assert.deepEqual(motion.frame(503), { offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, visible: true, active: false, smoke: 0 });
});

test('serialized motion factory has the same timeline as the imported studio factory', () => {
  const avatar = walkingCharacter(); const studio = createMotionAnimator();
  const overlay: ReturnType<typeof createMotionAnimator> = vm.runInNewContext(`(${createMotionAnimator.toString()})()`);
  for (const [now, presence] of [[0, { visible: true, sequence: 0 }], [10, { visible: false, sequence: 1 }], [350, { visible: false, sequence: 1 }], [600, { visible: true, sequence: 2 }], [700, { visible: true, sequence: 2 }], [1500, { visible: true, sequence: 2 }]] as const) {
    studio.update(avatar, presence, now); overlay.update(avatar, presence, now);
    assert.deepEqual(JSON.parse(JSON.stringify(overlay.frame(now))), JSON.parse(JSON.stringify(studio.frame(now))));
  }
});

test('walking touches actual wide and portrait viewport edges using transformed alpha bounds and travel facing', () => {
  for (const viewport of [{ width: 1600, height: 600 }, { width: 600, height: 1400 }]) {
    for (const side of ['left', 'right'] as const) for (const facing of ['left', 'right'] as const) {
      const avatar = walkingCharacter();
      avatar.motions!.enter = { ...avatar.motions!.enter!, side, facing };
      avatar.motions!.exit = { ...avatar.motions!.exit!, side, facing };
      // A padded image placed at x=35 and scaled 1.5 has these visible bounds.
      const bounds = { left: -70, right: 140, top: -210, bottom: 180 };
      const geometry = { ...viewport, bounds };
      const motion = createMotionAnimator();
      motion.update(avatar, { visible: false, sequence: 0 }, 0, geometry);
      motion.update(avatar, { visible: true, sequence: 1 }, 10, geometry);
      const first = motion.frame(10);
      assert.equal(first.flipX, (side === 'right') !== (facing === 'left'));
      const left = first.flipX ? -bounds.right : bounds.left;
      const right = first.flipX ? -bounds.left : bounds.right;
      assert.equal(side === 'right' ? first.offsetX + left : first.offsetX + right, side === 'right' ? viewport.width / 2 : -viewport.width / 2);
      const next = motion.frame(11);
      assert.ok(side === 'right' ? next.offsetX + left < viewport.width / 2 : next.offsetX + right > -viewport.width / 2, 'visible artwork enters on the first advancing frame');
      motion.frame(1010);
      motion.update(avatar, { visible: false, sequence: 2 }, 1100, geometry);
      assert.equal(motion.frame(1100).flipX, (side === 'left') !== (facing === 'left'));
      const last = motion.frame(2099);
      const lastLeft = last.flipX ? -bounds.right : bounds.left;
      const lastRight = last.flipX ? -bounds.left : bounds.right;
      assert.ok(side === 'right' ? last.offsetX + lastLeft < viewport.width / 2 : last.offsetX + lastRight > -viewport.width / 2, 'exit remains visible until it reaches the edge');
      assert.equal(motion.frame(2100).visible, false);
    }
  }
});

test('resizing a viewport retargets walking without a positional jump or duration restart', () => {
  const avatar = walkingCharacter(); const motion = createMotionAnimator();
  motion.update(avatar, { visible: false, sequence: 1 }, 0, { width: 600, height: 600 });
  const beforeResize = motion.frame(400).offsetX;
  motion.update(avatar, { visible: false, sequence: 1 }, 400, { width: 1600, height: 600 });
  assert.equal(motion.frame(400).offsetX, beforeResize);
  assert.ok(motion.frame(800).offsetX > beforeResize);
  assert.equal(motion.frame(1000).visible, false);
});

test('walk entry touches its first gait pixels even when original and later gait artwork are wider; exit uses gait union', () => {
  const avatar = walkingCharacter();
  avatar.motions!.enter!.side = 'right';
  const geometry = { width: 1200, height: 600, bounds: { left: -400, right: 400, top: -300, bottom: 300 }, spriteBounds: {
    'closed-1': { left: -400, right: 400, top: -300, bottom: 300 },
    'enter-1': { left: -50, right: 60, top: -180, bottom: 180 },
    'enter-2': { left: -90, right: 100, top: -180, bottom: 180 },
    'exit-1': { left: -70, right: 90, top: -180, bottom: 180 },
    'exit-2': { left: -120, right: 150, top: -180, bottom: 180 }
  } };
  const motion = createMotionAnimator();
  motion.update(avatar, { visible: false, sequence: 0 }, 0, geometry);
  motion.update(avatar, { visible: true, sequence: 1 }, 0, geometry);
  assert.equal(motion.frame(0).offsetX, 660);
  assert.equal(motion.frame(0).offsetX - geometry.spriteBounds['enter-1'].right, 600, 'mirrored first gait pixel touches the viewport');
  assert.ok(motion.frame(1).offsetX - geometry.spriteBounds['enter-1'].right < 600);
  motion.frame(1000);
  motion.update(avatar, { visible: false, sequence: 2 }, 1100, geometry);
  assert.equal(motion.frame(1600).offsetX, 360, 'departure endpoint is 600 + 120 from exit gait union');
  assert.equal(motion.frame(2100).visible, false);
});

test('fall and jump edge geometry uses original resting artwork bounds instead of preserved gait or global union', () => {
  const avatar = walkingCharacter();
  avatar.motions!.enter!.effect = avatar.motions!.exit!.effect = 'fall-jump';
  const geometry = { width: 600, height: 900, bounds: { left: -400, right: 400, top: -500, bottom: 500 }, spriteBounds: {
    'closed-1': { left: -80, right: 80, top: -120, bottom: 80 },
    'enter-1': { left: -200, right: 200, top: -500, bottom: 500 }
  } };
  const motion = createMotionAnimator();
  motion.update(avatar, { visible: false, sequence: 0 }, 0, geometry);
  motion.update(avatar, { visible: true, sequence: 1 }, 0, geometry);
  assert.equal(motion.frame(0).offsetY, -530);
  motion.frame(1000); motion.update(avatar, { visible: false, sequence: 2 }, 1100, geometry);
  const crouch = motion.frame(1280);
  assert.ok(Math.abs(crouch.offsetY - 12) < 0.0001, 'crouch stays anchored to the original 80px bottom extent');
});

test('smoke appears and disappears at the anchor using original artwork without motion frames', () => {
  const avatar = character(); avatar.motions = {
    enter: { effect: 'smoke', frames: [], frameMs: 100, durationMs: 1000, side: 'right' },
    exit: { effect: 'smoke', frames: [], frameMs: 100, durationMs: 1000, side: 'right' }
  };
  const motion = createMotionAnimator();
  motion.update(avatar, { visible: false, sequence: 0 }, 0);
  motion.update(avatar, { visible: true, sequence: 1 }, 10);
  assert.equal(motion.frame(10).opacity, 0);
  assert.equal(motion.frame(10).sprite?.id, avatar.closed[0].id);
  const puff = motion.frame(510);
  assert.equal(puff.offsetX, 0); assert.equal(puff.offsetY, 0); assert.equal(puff.smoke, 1);
  assert.ok(puff.opacity > 0.9);
  assert.equal(motion.frame(1010).visible, true);
  motion.update(avatar, { visible: false, sequence: 2 }, 1100);
  assert.equal(motion.frame(1100).opacity, 1);
  assert.equal(motion.frame(1700).opacity, 0);
  assert.ok(motion.frame(1700).smoke > 0);
  assert.equal(motion.frame(2100).visible, false);
  assert.equal(motion.frame(2200).smoke, 0);
});

test('local effects ignore preserved gait artwork when switching an existing walking clip', () => {
  for (const effect of ['smoke', 'fall-jump'] as const) {
    const avatar = walkingCharacter();
    avatar.motions!.enter!.effect = effect;
    avatar.motions!.exit!.effect = effect;
    const motion = createMotionAnimator();
    motion.update(avatar, { visible: false, sequence: 0 }, 0);
    motion.update(avatar, { visible: true, sequence: 1 }, 10);
    for (const now of [10, 210, 510, 910]) assert.equal(motion.frame(now).sprite?.id, avatar.closed[0].id, `${effect} enters with original artwork at ${now}`);
    motion.frame(1010);
    motion.update(avatar, { visible: false, sequence: 2 }, 1100);
    for (const now of [1100, 1300, 1600, 2000]) assert.equal(motion.frame(now).sprite?.id, avatar.closed[0].id, `${effect} exits with original artwork at ${now}`);
    assert.equal(avatar.motions!.enter!.frames[0].id, 'enter-1', 'gait artwork remains available when switching back');
  }
});

test('fall enters from the actual top edge, lands with bounce, then crouches and jumps completely offscreen', () => {
  const avatar = character(); avatar.motions = {
    enter: { effect: 'fall-jump', frames: [], frameMs: 100, durationMs: 1000, side: 'right' },
    exit: { effect: 'fall-jump', frames: [], frameMs: 100, durationMs: 1000, side: 'right' }
  };
  const geometry = { width: 600, height: 1400, bounds: { left: -90, right: 110, top: -200, bottom: 160 } };
  const motion = createMotionAnimator();
  motion.update(avatar, { visible: false, sequence: 0 }, 0, geometry);
  motion.update(avatar, { visible: true, sequence: 1 }, 0, geometry);
  assert.equal(motion.frame(0).offsetY + geometry.bounds.bottom, -geometry.height / 2);
  assert.ok(motion.frame(100).offsetY > motion.frame(0).offsetY);
  assert.ok(motion.frame(360).offsetY > motion.frame(500).offsetY, 'landing rebounds upward');
  assert.equal(motion.frame(1000).offsetY, 0);
  motion.update(avatar, { visible: false, sequence: 2 }, 1100, geometry);
  const crouch = motion.frame(1280);
  assert.ok(crouch.scale < 1); assert.ok(crouch.offsetY > 0);
  assert.ok(motion.frame(1900).offsetY < -500);
  const last = motion.frame(2099);
  assert.ok(last.offsetY + geometry.bounds.bottom > -geometry.height / 2, 'last jump pixels leave through top edge');
  assert.equal(motion.frame(2100).visible, false);
});

test('serialized effects and geometry retargeting match studio, including repeated snapshots and late frames', () => {
  for (const effect of ['walk', 'smoke', 'fall-jump'] as const) {
    const avatar = walkingCharacter();
    for (const clip of Object.values(avatar.motions!)) { clip.effect = effect; clip.side = 'right'; clip.facing = 'right'; if (effect !== 'walk') clip.frames = []; }
    const studio = createMotionAnimator();
    const overlay: ReturnType<typeof createMotionAnimator> = vm.runInNewContext(`(${createMotionAnimator.toString()})()`);
    for (const [now, visible, sequence, width] of [[0, false, 0, 1600], [10, true, 1, 1600], [9, true, 1, 1600], [320, true, 1, 1600], [400, true, 1, 1900], [1010, true, 1, 1900], [1100, false, 2, 1900], [1400, false, 2, 1900], [2100, false, 2, 1900]] as const) {
      const geometry = { width, height: 600, bounds: { left: -80, right: 120, top: -220, bottom: 200 }, spriteBounds: {
        'closed-1': { left: -70, right: 70, top: -200, bottom: 160 },
        'enter-1': { left: -40, right: 55, top: -180, bottom: 170 },
        'enter-2': { left: -60, right: 65, top: -180, bottom: 170 },
        'exit-1': { left: -45, right: 60, top: -180, bottom: 170 },
        'exit-2': { left: -65, right: 75, top: -180, bottom: 170 }
      } };
      studio.update(avatar, { visible, sequence }, now, geometry); overlay.update(avatar, { visible, sequence }, now, geometry);
      assert.deepEqual(JSON.parse(JSON.stringify(overlay.frame(now))), JSON.parse(JSON.stringify(studio.frame(now))), `${effect} at ${now}`);
    }
  }
});

test('smoke drawing is deterministic, serialized, and clears its transparent canvas after completion', () => {
  const trace = () => {
    const calls: unknown[] = [];
    const context = {
      clearRect(...args: number[]) { calls.push(['clear', ...args]); }, save() { calls.push('save'); }, restore() { calls.push('restore'); },
      translate(...args: number[]) { calls.push(['translate', ...args]); },
      createRadialGradient(...args: number[]) { calls.push(['gradient', ...args]); return { addColorStop(...values: unknown[]) { calls.push(['stop', ...values]); } }; },
      beginPath() {}, arc(...args: number[]) { calls.push(['arc', ...args]); }, fill() {}, fillStyle: undefined as unknown
    };
    return { calls, context: context as unknown as CanvasRenderingContext2D };
  };
  const studio = trace(); const overlay = trace();
  const serialized: typeof drawSmokePuff = vm.runInNewContext(`(${drawSmokePuff.toString()})`);
  drawSmokePuff(studio.context, 0.7, 600, 600); serialized(overlay.context, 0.7, 600, 600);
  assert.deepEqual(overlay.calls, studio.calls);
  assert.equal(studio.calls.filter(call => Array.isArray(call) && call[0] === 'arc').length, 32);
  const cleared = trace(); drawSmokePuff(cleared.context, 0, 600, 600);
  assert.deepEqual(cleared.calls, [['clear', 0, 0, 600, 600]]);
});
