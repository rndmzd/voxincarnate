import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositeMouthPixels, compositeSpeechPixels, contextAroundRegion, fitSpriteToCanvas, padSpritePixels, regionToPixels, validFaceRegion } from '../character-compositing.js';
import { VISEMES } from '../shared.js';

function texturedImage(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    bytes.set([(x * 19 + y * 7) % 256, (x * y * 11) % 256, (x * 13 + y * 23) % 256, (x + y) % 5 === 0 ? 0 : (x + y) % 7 === 0 ? 93 : 255], i);
  }
  return bytes;
}

test('every speech pose preserves textured body pixels outside the mouth, original alpha, and transparent holes', () => {
  const width = 40, height = 60;
  const region = { x: 16, y: 12, width: 8, height: 6 };
  const base = texturedImage(width, height);
  const original = new Uint8Array(base);
  for (const [pose, index] of VISEMES.map((pose, index) => [pose, index] as const)) {
    const patch = new Uint8Array(region.width * region.height * 4);
    for (let i = 0; i < patch.length; i += 4) patch.set([20 + index, 190 - index, 50 + index * 2, 255], i);
    const patchOriginal = new Uint8Array(patch);
    const result = compositeMouthPixels(base, patch, width, height, region, 0);
    assert.notEqual(result, base);
    let changed = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height;
      assert.equal(result[i + 3], original[i + 3], `${pose}: alpha at ${x},${y}`);
      if (!inside || original[i + 3] === 0) assert.deepEqual(result.subarray(i, i + 4), original.subarray(i, i + 4), `${pose}: fixed source at ${x},${y}`);
      else if (result[i] !== original[i]) changed++;
    }
    assert.ok(changed > 0, `${pose} changes visible mouth pixels`);
    assert.deepEqual(base, original, 'base is never mutated between poses');
    assert.deepEqual(patch, patchOriginal, 'patch is never mutated');
  }
});

test('feathering keeps the crop edge fixed, blends only its inner perimeter, and retains opaque center', () => {
  const width = 20, height = 20;
  const base = new Uint8Array(width * height * 4);
  for (let i = 0; i < base.length; i += 4) base.set([10, 20, 30, 255], i);
  const region = { x: 5, y: 5, width: 9, height: 9 };
  const patch = new Uint8Array(9 * 9 * 4);
  for (let i = 0; i < patch.length; i += 4) patch.set([110, 120, 130, 255], i);
  const result = compositeMouthPixels(base, patch, width, height, region, 2);
  const pixel = (x: number, y: number) => [...result.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.deepEqual(pixel(4, 9), [10, 20, 30, 255]);
  assert.deepEqual(pixel(5, 9), [10, 20, 30, 255]);
  assert.deepEqual(pixel(6, 9), [60, 70, 80, 255]);
  assert.deepEqual(pixel(7, 9), [110, 120, 130, 255]);
  assert.deepEqual(pixel(9, 9), [110, 120, 130, 255]);
});

test('patch transparency cannot punch holes into or replace source alpha', () => {
  const base = texturedImage(12, 12);
  const patch = new Uint8Array(4 * 4 * 4).fill(255);
  patch.fill(0, 0, 4);
  const region = { x: 4, y: 4, width: 4, height: 4 };
  const result = compositeMouthPixels(base, patch, 12, 12, region, 0);
  const first = (4 * 12 + 4) * 4;
  assert.deepEqual(result.subarray(first, first + 4), base.subarray(first, first + 4));
  for (let i = 3; i < result.length; i += 4) assert.equal(result[i], base[i]);
});

test('premultiplied patches use the preserved source alpha and remain valid at translucent pixels', () => {
  const width = 8, height = 8;
  const region = { x: 3, y: 3, width: 2, height: 2 };
  const base = new Uint8Array(width * height * 4);
  for (let i = 0; i < base.length; i += 4) base.set([32, 64, 96, 128], i);
  base.fill(0, 0, 4);
  const original = new Uint8Array(base);
  const patch = new Uint8Array([
    200, 100, 50, 255, 100, 50, 25, 128,
    255, 255, 255, 255, 0, 0, 0, 0
  ]);
  const result = compositeMouthPixels(base, patch, width, height, region, 0, true);
  const pixel = (x: number, y: number) => [...result.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
  assert.deepEqual(pixel(3, 3), [100, 50, 25, 128], 'opaque generated skin uses the translucent original alpha');
  assert.deepEqual(pixel(4, 3), [66, 57, 60, 128], 'translucent premultiplied patch blends its straight color correctly');
  assert.deepEqual(pixel(3, 4), [128, 128, 128, 128]);
  assert.deepEqual(pixel(4, 4), [32, 64, 96, 128], 'transparent patch preserves source');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (x < 3 || x > 4 || y < 3 || y > 4) assert.deepEqual(result.subarray(i, i + 4), original.subarray(i, i + 4));
    assert.equal(result[i + 3], original[i + 3]);
    for (let channel = 0; channel < 3; channel++) assert.ok(result[i + channel] <= result[i + 3]);
  }
  assert.deepEqual(base, original);
});

test('normalized mouth selection rounds outward and permits the image boundaries', () => {
  assert.deepEqual(regionToPixels({ x: 0.101, y: 0.201, width: 0.11, height: 0.11 }, 100, 80), { x: 10, y: 16, width: 12, height: 9 });
  assert.deepEqual(regionToPixels({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 }, 100, 100), { x: 80, y: 80, width: 20, height: 20 });
});

test('invalid selections, dimensions, buffers, and feather bounds fail before drawing', () => {
  for (const region of [
    { x: NaN, y: 0, width: 0.1, height: 0.1 }, { x: 0, y: Infinity, width: 0.1, height: 0.1 },
    { x: 0, y: 0, width: 0.001, height: 0.1 }, { x: 0, y: 0, width: 1, height: 1 },
    { x: -0.1, y: 0, width: 0.1, height: 0.1 }, { x: 0.95, y: 0, width: 0.1, height: 0.1 }
  ]) assert.throws(() => regionToPixels(region, 100, 100), RangeError);
  for (const [width, height] of [[0, 10], [8193, 10], [10, 1.1], [10, NaN]]) assert.throws(() => regionToPixels({ x: 0, y: 0, width: 0.1, height: 0.1 }, width, height), RangeError);
  const base = texturedImage(10, 10), patch = new Uint8Array(2 * 2 * 4);
  for (const region of [
    { x: -1, y: 1, width: 2, height: 2 }, { x: 9, y: 1, width: 2, height: 2 },
    { x: 1, y: 1, width: 0, height: 2 }, { x: 1.5, y: 1, width: 2, height: 2 },
    { x: 0, y: 0, width: 10, height: 10 }
  ]) assert.throws(() => compositeMouthPixels(base, patch, 10, 10, region), RangeError);
  const region = { x: 1, y: 1, width: 2, height: 2 };
  assert.throws(() => compositeMouthPixels(base.subarray(1), patch, 10, 10, region), RangeError);
  assert.throws(() => compositeMouthPixels(base, patch.subarray(1), 10, 10, region), RangeError);
  for (const feather of [-1, Infinity, 1.5, 8193]) assert.throws(() => compositeMouthPixels(base, patch, 10, 10, region, feather), RangeError);
});

test('speech blending matches surrounding textured skin without washing out the mouth expression', () => {
  const width = 84, height = 72, region = { x: 24, y: 18, width: 36, height: 28 };
  const base = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    base.set([120 + x % 17 + y % 13, 145 + x % 11, 155 + y % 19, 255], (y * width + x) * 4);
  }
  const patch = new Uint8Array(region.width * region.height * 4);
  for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
    const i = ((region.y + y) * width + region.x + x) * 4, p = (y * region.width + x) * 4;
    patch.set([base[i] + 18, base[i + 1] - 11, base[i + 2] + 7, 255], p);
    const radius = Math.hypot((x - 17.5) / 17.5, (y - 13.5) / 13.5);
    // Highlights or generated edge artifacts must not bias the global color match.
    if (radius >= 0.82 && radius <= 1.02 && (x + y) % 5 === 0) patch.set([255, 0, 255, 255], p);
    if (x >= 14 && x <= 21 && y >= 12 && y <= 15) patch.set([33, 1, 25, 255], p);
  }
  const previous = compositeMouthPixels(base, patch, width, height, region, 2);
  const output = compositeSpeechPixels(base, patch, width, height, region);
  let previousError = 0, matchedError = 0, samples = 0;
  for (let y = 0; y < region.height; y++) for (let x = 0; x < region.width; x++) {
    const radius = Math.hypot((x - 17.5) / 17.5, (y - 13.5) / 13.5);
    if (radius < 0.65 || radius > 0.8) continue;
    const i = ((region.y + y) * width + region.x + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      previousError += Math.abs(previous[i + channel] - base[i + channel]);
      matchedError += Math.abs(output[i + channel] - base[i + channel]);
      samples++;
    }
  }
  assert.ok(samples > 100);
  assert.ok(previousError / samples > 9, 'old two-pixel patch has a visible color step');
  assert.equal(matchedError, 0, 'new broad blend removes the lighting mismatch while retaining skin texture');
  const center = ((region.y + 14) * width + region.x + 18) * 4;
  assert.deepEqual([...output.subarray(center, center + 4)], [15, 12, 18, 255], 'dark mouth interior retains its expression and contrast');
});

test('speech blending protects elliptical corners, the outer ring, source alpha, and both input buffers', () => {
  const width = 60, height = 60, region = { x: 15, y: 14, width: 24, height: 28 };
  const base = texturedImage(width, height), original = new Uint8Array(base);
  const patch = new Uint8Array(region.width * region.height * 4);
  for (let i = 0; i < patch.length; i += 4) patch.set([230, 180, 80, 255], i);
  const patchOriginal = new Uint8Array(patch);
  const output = compositeSpeechPixels(base, patch, width, height, region);
  let changed = 0, partiallyBlended = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const localX = x - region.x, localY = y - region.y;
    const radius = Math.hypot((localX - 11.5) / 11.5, (localY - 13.5) / 13.5);
    const outerRing = localX <= 0 || localY <= 0 || localX >= region.width - 1 || localY >= region.height - 1;
    assert.equal(output[i + 3], original[i + 3]);
    if (outerRing || radius >= 1 || original[i + 3] === 0) {
      assert.deepEqual(output.subarray(i, i + 4), original.subarray(i, i + 4), `protected source at ${x},${y}`);
    } else if (output[i] !== original[i]) {
      changed++;
      if (radius > 0.62 && output[i] !== patch[(localY * region.width + localX) * 4]) partiallyBlended++;
    }
  }
  assert.ok(changed > 150);
  assert.ok(partiallyBlended > 50, 'feather width scales with the face, rather than staying two pixels wide');
  assert.deepEqual(base, original);
  assert.deepEqual(patch, patchOriginal);
});

test('speech color matching is bounded and respects premultiplied translucent source pixels', () => {
  const width = 30, height = 30, region = { x: 9, y: 9, width: 12, height: 12 };
  const base = new Uint8Array(width * height * 4);
  for (let i = 0; i < base.length; i += 4) base.set([30, 50, 60, 96], i);
  const patch = new Uint8Array(region.width * region.height * 4);
  for (let i = 0; i < patch.length; i += 4) patch.set([150, 200, 220, 255], i);
  const transparentSource = (14 * width + 14) * 4;
  base.set([0, 0, 0, 0], transparentSource);
  const transparentPatch = (6 * region.width + 6) * 4;
  patch.set([0, 0, 0, 0], transparentPatch);
  const output = compositeSpeechPixels(base, patch, width, height, region, true);
  for (let i = 0; i < output.length; i += 4) {
    assert.equal(output[i + 3], base[i + 3]);
    for (let channel = 0; channel < 3; channel++) assert.ok(output[i + channel] <= output[i + 3]);
  }
  assert.deepEqual([...output.subarray(transparentSource, transparentSource + 4)], [0, 0, 0, 0]);
  const center = (15 * width + 14) * 4;
  assert.deepEqual([...output.subarray(center, center + 4)], [44, 63, 71, 96], 'large lighting shifts are limited to a 32-level straight-color correction');
  const preserved = (15 * width + 15) * 4;
  assert.deepEqual(output.subarray(preserved, preserved + 4), base.subarray(preserved, preserved + 4), 'transparent generated pixels preserve the source');
});

test('context crops include facial surroundings while containing the exact edit selection', () => {
  assert.deepEqual(contextAroundRegion({ x: 40, y: 20, width: 20, height: 10 }, 100, 80), { x: 34, y: 9, width: 32, height: 32 });
  assert.deepEqual(contextAroundRegion({ x: 0, y: 0, width: 20, height: 10 }, 100, 80), { x: 0, y: 0, width: 32, height: 32 });
  assert.deepEqual(contextAroundRegion({ x: 80, y: 70, width: 20, height: 10 }, 100, 80), { x: 68, y: 48, width: 32, height: 32 });
  assert.deepEqual(contextAroundRegion({ x: 1, y: 10, width: 18, height: 50 }, 20, 100), { x: 0, y: 10, width: 20, height: 50 }, 'narrow portraits use a containing rectangle when a square cannot contain the selection');
  assert.throws(() => contextAroundRegion({ x: 95, y: 0, width: 20, height: 10 }, 100, 80), RangeError);
});

test('face edits accept portraits up to 65% while mouth edits retain their smaller limit', () => {
  const face = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
  assert.equal(validFaceRegion(face), true);
  assert.deepEqual(regionToPixels(face, 100, 100, 0.65), { x: 10, y: 10, width: 80, height: 80 });
  assert.throws(() => regionToPixels(face, 100, 100), RangeError);
  assert.equal(validFaceRegion({ x: 0, y: 0, width: 1, height: 0.7 }), false);
  const base = new Uint8Array(100 * 100 * 4), patch = new Uint8Array(80 * 80 * 4);
  assert.doesNotThrow(() => compositeSpeechPixels(base, patch, 100, 100, { x: 10, y: 10, width: 80, height: 80 }));
  assert.throws(() => compositeSpeechPixels(base, patch, 100, 100, { x: 0, y: 0, width: 90, height: 80 }), RangeError);
  assert.throws(() => compositeSpeechPixels(base.subarray(1), patch, 100, 100, { x: 10, y: 10, width: 80, height: 80 }), RangeError);
  assert.throws(() => regionToPixels(face, 100, 100, 1), RangeError);
});

test('outward rounding of a valid small portrait remains compositable without admitting full-image replacement', () => {
  const face = { x: 0.1, y: 0.05, width: 0.8, height: 0.8 };
  assert.equal(validFaceRegion(face), true, 'normalized face covers 64%');
  const region = regionToPixels(face, 64, 64, 0.65);
  assert.deepEqual(region, { x: 6, y: 3, width: 52, height: 52 });
  assert.ok(region.width * region.height > 64 * 64 * 0.65, 'outward rounding crosses the nominal pixel cap');
  const base = new Uint8Array(64 * 64 * 4);
  const patch = new Uint8Array(region.width * region.height * 4);
  assert.doesNotThrow(() => compositeSpeechPixels(base, patch, 64, 64, region));
  assert.throws(() => compositeSpeechPixels(base, new Uint8Array(64 * 64 * 4), 64, 64, { x: 0, y: 0, width: 64, height: 64 }), RangeError);
  assert.throws(() => compositeSpeechPixels(base, new Uint8Array(60 * 60 * 4), 64, 64, { x: 2, y: 2, width: 60, height: 60 }), RangeError);
  assert.throws(() => compositeSpeechPixels(base, patch, 64, 64, { ...region, x: 13 }), RangeError, 'rounding never permits an out-of-bounds crop');
  assert.throws(() => compositeSpeechPixels(new Uint8Array(4 * 4 * 4), new Uint8Array(4 * 4 * 4), 4, 4, { x: 0, y: 0, width: 4, height: 4 }), RangeError, 'full-image replacement also fails on tiny inputs');
});

test('walking cells keep their proportions, canvas dimensions and common foot baseline on portrait and landscape references', () => {
  for (const [width, height, expected] of [
    [60, 90, { x: 0, y: 30, width: 60, height: 60 }],
    [90, 60, { x: 15, y: 0, width: 60, height: 60 }],
    [60, 60, { x: 0, y: 0, width: 60, height: 60 }]
  ] as const) {
    const fitted = fitSpriteToCanvas(512, 512, width, height);
    assert.deepEqual({ ...fitted }, expected);
    assert.equal(fitted.width, fitted.height, 'square gait artwork retains its proportions');
    for (let frame = 0; frame < 4; frame++) {
      const bitmap = new Uint8Array(fitted.width * fitted.height * 4);
      for (let y = 0; y < fitted.height; y++) for (let x = 0; x < fitted.width; x++) {
        bitmap.set([x, y, frame + 1, 255], (y * fitted.width + x) * 4);
      }
      const original = new Uint8Array(bitmap);
      const canvas = padSpritePixels(bitmap, width, height, fitted);
      assert.equal(canvas.length, width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const pixel = canvas.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
        const inside = x >= fitted.x && x < fitted.x + fitted.width && y >= fitted.y && y < fitted.y + fitted.height;
        assert.deepEqual([...pixel], inside ? [x - fitted.x, y - fitted.y, frame + 1, 255] : [0, 0, 0, 0]);
      }
      assert.equal(canvas[((height - 1) * width + fitted.x) * 4 + 1], fitted.height - 1, 'each gait frame shares its bottom origin');
      assert.deepEqual(bitmap, original);
    }
  }
});

test('sprite fitting handles nonsquare cells uniformly and rejects invalid canvas placement before copying', () => {
  assert.deepEqual(fitSpriteToCanvas(400, 200, 60, 90), { x: 0, y: 60, width: 60, height: 30 });
  assert.deepEqual(fitSpriteToCanvas(200, 400, 90, 60), { x: 30, y: 0, width: 30, height: 60 });
  for (const [width, height] of [[0, 60], [60, NaN], [8193, 60], [60.5, 60]]) assert.throws(() => fitSpriteToCanvas(512, 512, width, height), RangeError);
  assert.throws(() => fitSpriteToCanvas(0, 512, 60, 90), RangeError);
  assert.throws(() => padSpritePixels(new Uint8Array(4), 60, 90, { x: 0, y: 0, width: 60, height: 60 }), RangeError);
  assert.throws(() => padSpritePixels(new Uint8Array(4), 60, 90, { x: 60, y: 0, width: 1, height: 1 }), RangeError);
});
