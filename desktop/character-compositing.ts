import type { NormalizedRegion } from './shared';

export interface PixelRegion { x: number; y: number; width: number; height: number }

function dimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
    width > 8192 || height > 8192) throw new RangeError('Image dimensions must be whole numbers between 1 and 8,192.');
}

/** A mouth edit may cover at most a quarter of the source, never its entire body. */
export function validMouthRegion(region: NormalizedRegion): boolean {
  return validRegion(region, 0.25);
}

/** A portrait may need most of the face, but its background and body remain protected. */
export function validFaceRegion(region: NormalizedRegion): boolean {
  return validRegion(region, 0.65);
}

function validRegion(region: NormalizedRegion, maxArea: number): boolean {
  return !!region && [region.x, region.y, region.width, region.height].every(Number.isFinite) &&
    region.x >= 0 && region.y >= 0 && region.width >= 0.005 && region.height >= 0.005 &&
    region.x + region.width <= 1 && region.y + region.height <= 1 && region.width * region.height <= maxArea;
}

/** Round outward so the selected mouth area is included; reject invalid or expansive edits. */
export function regionToPixels(region: NormalizedRegion, width: number, height: number, maxArea = 0.25): PixelRegion {
  dimensions(width, height);
  if (!Number.isFinite(maxArea) || maxArea <= 0 || maxArea > 0.65) throw new RangeError('Speech edit area must be greater than zero and no more than 65%.');
  if (!validRegion(region, maxArea)) throw new RangeError(`Choose a visible speech area within the image, covering no more than ${Math.round(maxArea * 100)}% of it.`);
  const x = Math.floor(region.x * width);
  const y = Math.floor(region.y * height);
  const right = Math.min(width, Math.ceil((region.x + region.width) * width));
  const bottom = Math.min(height, Math.ceil((region.y + region.height) * height));
  return { x, y, width: right - x, height: bottom - y };
}

function validPixelRegion(region: PixelRegion, width: number, height: number, maxArea = 1): boolean {
  return !!region && [region.x, region.y, region.width, region.height].every(Number.isSafeInteger) &&
    region.x >= 0 && region.y >= 0 && region.width >= 1 && region.height >= 1 &&
    region.x + region.width <= width && region.y + region.height <= height &&
    region.width * region.height <= width * height * maxArea;
}

/** Uniformly fit a gait cell into its character canvas, keeping every frame bottom-centered. */
export function fitSpriteToCanvas(sourceWidth: number, sourceHeight: number, width: number, height: number): PixelRegion {
  dimensions(sourceWidth, sourceHeight); dimensions(width, height);
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const fittedWidth = Math.max(1, Math.min(width, Math.round(sourceWidth * scale)));
  const fittedHeight = Math.max(1, Math.min(height, Math.round(sourceHeight * scale)));
  return { x: Math.floor((width - fittedWidth) / 2), y: height - fittedHeight, width: fittedWidth, height: fittedHeight };
}

/** Place a resized native bitmap without altering its pixels; unused canvas pixels stay transparent. */
export function padSpritePixels(pixels: Uint8Array, width: number, height: number, region: PixelRegion): Uint8Array {
  dimensions(width, height);
  if (!validPixelRegion(region, width, height) || !(pixels instanceof Uint8Array) || pixels.length !== region.width * region.height * 4) {
    throw new RangeError('Sprite pixels and placement must fit their canvas.');
  }
  const output = new Uint8Array(width * height * 4);
  const rowBytes = region.width * 4;
  for (let y = 0; y < region.height; y++) {
    output.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), ((region.y + y) * width + region.x) * 4);
  }
  return output;
}

/**
 * Include surrounding facial detail for generation without expanding the editable
 * region. Prefer a square with 60% extra room, shifted inside the source. A narrow
 * source can only provide a rectangle when the selection cannot fit in a square.
 */
export function contextAroundRegion(region: PixelRegion, width: number, height: number): PixelRegion {
  dimensions(width, height);
  if (!validPixelRegion(region, width, height)) throw new RangeError('Speech context bounds must lie inside the source image.');
  const side = Math.ceil(Math.max(region.width, region.height) * 1.6);
  const contextWidth = Math.max(region.width, Math.min(side, width, height));
  const contextHeight = Math.max(region.height, Math.min(side, width, height));
  return {
    x: Math.max(0, Math.min(width - contextWidth, Math.floor(region.x + (region.width - contextWidth) / 2))),
    y: Math.max(0, Math.min(height - contextHeight, Math.floor(region.y + (region.height - contextHeight) / 2))),
    width: contextWidth,
    height: contextHeight
  };
}

/**
 * Blend a generated speech region into its source using a broad, smooth elliptical
 * transition. Match modest lighting/color drift from the unchanged facial perimeter,
 * using medians so isolated teeth, lips, or highlights cannot dominate the correction.
 * The center retains the generated expression and its contrast. Source alpha and
 * every byte outside the ellipse remain exact, including transparent source holes.
 * Supports either RGB or BGR channel order and native premultiplied image buffers.
 */
export function compositeSpeechPixels(
  base: Uint8Array, patch: Uint8Array, width: number, height: number,
  region: PixelRegion, premultiplied = false
): Uint8Array {
  dimensions(width, height);
  if (!validPixelRegion(region, width, height)) throw new RangeError('Speech patch bounds must lie inside the source image.');
  // Main validates the normalized selection before generation. Outward conversion
  // can add up to two pixels to either dimension, especially on small portraits.
  // Admit that rounding only; a complete source replacement is never an edit.
  const imageArea = width * height;
  const roundedArea = region.width * region.height;
  const roundingAllowance = 2 * (region.width + region.height) + 4;
  if (roundedArea >= imageArea || roundedArea > imageArea * 0.65 + roundingAllowance) {
    throw new RangeError('Speech patch bounds exceed the permitted face area.');
  }
  if (!(base instanceof Uint8Array) || !(patch instanceof Uint8Array) ||
    base.length !== width * height * 4 || patch.length !== region.width * region.height * 4) {
    throw new RangeError('Speech patch buffers must match their image dimensions.');
  }
  const output = new Uint8Array(base);
  // A fixed outer pixel ring needs at least one pixel of editable interior.
  if (region.width < 3 || region.height < 3) return output;
  const radiusX = (region.width - 1) / 2;
  const radiusY = (region.height - 1) / 2;
  const radiusAt = (x: number, y: number) => Math.hypot((x - radiusX) / radiusX, (y - radiusY) / radiusY);
  const differences: number[][] = [[], [], []];
  // Bound the sample count on large portraits, while keeping small faces well sampled.
  const stride = Math.max(1, Math.floor(Math.sqrt(region.width * region.height / 4096)));
  for (let y = 0; y < region.height; y += stride) for (let x = 0; x < region.width; x += stride) {
    const radius = radiusAt(x, y);
    if (radius < 0.82 || radius > 1.02) continue;
    const target = ((region.y + y) * width + region.x + x) * 4;
    const source = (y * region.width + x) * 4;
    const baseAlpha = base[target + 3], patchAlpha = patch[source + 3];
    if (baseAlpha < 64 || patchAlpha < 64) continue;
    for (let channel = 0; channel < 3; channel++) {
      const baseColor = premultiplied ? base[target + channel] * 255 / baseAlpha : base[target + channel];
      const patchColor = premultiplied ? patch[source + channel] * 255 / patchAlpha : patch[source + channel];
      differences[channel].push(baseColor - patchColor);
    }
  }
  const offsets = differences.map(values => {
    if (values.length < 12) return 0;
    values.sort((a, b) => a - b);
    const middle = Math.floor(values.length / 2);
    const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
    return Math.max(-32, Math.min(32, median));
  });
  for (let y = 1; y < region.height - 1; y++) for (let x = 1; x < region.width - 1; x++) {
    const radius = radiusAt(x, y);
    if (radius >= 1) continue;
    const target = ((region.y + y) * width + region.x + x) * 4;
    const source = (y * region.width + x) * 4;
    const baseAlpha = base[target + 3], patchAlpha = patch[source + 3];
    if (baseAlpha === 0 || patchAlpha === 0) continue;
    const feather = radius <= 0.62 ? 1 : (1 + Math.cos(Math.PI * (radius - 0.62) / 0.38)) / 2;
    const weight = feather * patchAlpha / 255;
    for (let channel = 0; channel < 3; channel++) {
      const straightPatch = premultiplied ? patch[source + channel] * 255 / patchAlpha : patch[source + channel];
      const matched = Math.max(0, Math.min(255, straightPatch + offsets[channel]));
      const patchColor = premultiplied ? matched * baseAlpha / 255 : matched;
      output[target + channel] = Math.max(0, Math.min(premultiplied ? baseAlpha : 255,
        Math.round(base[target + channel] * (1 - weight) + patchColor * weight)));
    }
  }
  return output;
}

/**
 * Copy an already-sized mouth patch into the original. The first three channels may
 * be RGB or BGR; alpha is always fourth. Preserve source alpha, transparent holes,
 * and every byte outside the selection. For native premultiplied bitmaps, convert
 * patch color to the preserved source alpha before blending. No input is mutated.
 */
export function compositeMouthPixels(
  base: Uint8Array, patch: Uint8Array, width: number, height: number,
  region: PixelRegion, featherPx = 2, premultiplied = false
): Uint8Array {
  dimensions(width, height);
  if (!region || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
    region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 ||
    region.x + region.width > width || region.y + region.height > height ||
    region.width * region.height > width * height * 0.25) throw new RangeError('Mouth patch bounds are invalid or cover more than 25% of the image.');
  if (!(base instanceof Uint8Array) || !(patch instanceof Uint8Array) ||
    base.length !== width * height * 4 || patch.length !== region.width * region.height * 4) {
    throw new RangeError('Mouth patch buffers must match their image dimensions.');
  }
  if (!Number.isSafeInteger(featherPx) || featherPx < 0 || featherPx > 8192) throw new RangeError('Mouth feather must be a whole number between 0 and 8,192.');
  const output = new Uint8Array(base);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const target = ((region.y + y) * width + region.x + x) * 4;
      const source = (y * region.width + x) * 4;
      if (base[target + 3] === 0 || patch[source + 3] === 0) continue;
      const edge = Math.min(x, y, region.width - 1 - x, region.height - 1 - y);
      const feather = featherPx === 0 ? 1 : Math.min(1, edge / featherPx);
      const weight = feather * patch[source + 3] / 255;
      for (let channel = 0; channel < 3; channel++) {
        const patchColor = premultiplied ? patch[source + channel] * base[target + 3] / patch[source + 3] : patch[source + channel];
        const color = Math.round(base[target + channel] * (1 - weight) + patchColor * weight);
        output[target + channel] = Math.min(premultiplied ? base[target + 3] : 255, color);
      }
    }
  }
  return output;
}
