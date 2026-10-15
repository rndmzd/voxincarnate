import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_DETECTOR, type AppSettings, type Character, type Library, type Sprite } from './shared.js';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const clone = <T>(value: T): T => structuredClone(value);
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object.`);
  assert(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), `${label} has unsupported or missing fields.`);
}
function number(value: unknown, min: number, max: number, label: string, integer = false): asserts value is number {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)), `${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
}
function text(value: unknown, max: number, label: string, empty = false): asserts value is string {
  assert(typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= max && !/[\u0000-\u001f]/.test(value), `${label} is invalid.`);
}
export function validateCharacter(value: unknown): asserts value is Character {
  object(value, ['id', 'name', 'width', 'height', 'closed', 'open', 'frameMs'], 'Character');
  assert(typeof value.id === 'string' && ID.test(value.id), 'Character ID must be a UUID.');
  text(value.name, 120, 'Character name');
  number(value.width, 64, 4096, 'Canvas width', true); number(value.height, 64, 4096, 'Canvas height', true);
  number(value.frameMs, 40, 10000, 'Frame duration', true);
  const ids = new Set<string>();
  for (const pose of ['closed', 'open'] as const) {
    const sprites = value[pose];
    assert(Array.isArray(sprites) && sprites.length >= 1 && sprites.length <= 64, `Add between 1 and 64 ${pose}-mouth images.`);
    for (const sprite of sprites) {
      object(sprite, ['id', 'file', 'name', 'x', 'y', 'scale'], 'Sprite');
      assert(typeof sprite.id === 'string' && ID.test(sprite.id) && !ids.has(sprite.id), 'Sprite IDs must be unique UUIDs.');
      ids.add(sprite.id);
      assert(typeof sprite.file === 'string' && ASSET.test(sprite.file), 'Sprite asset filename is invalid.');
      text(sprite.name, 200, 'Image name'); number(sprite.x, -8192, 8192, 'Image X'); number(sprite.y, -8192, 8192, 'Image Y'); number(sprite.scale, 0.05, 10, 'Image scale');
    }
  }
}
export function validateSettings(value: unknown): asserts value is AppSettings {
  object(value, ['activeCharacterId', 'mode', 'inputId', 'browserInputId', 'assistantUrl', 'overlayPort', 'detector'], 'Settings');
  assert(typeof value.activeCharacterId === 'string' && ID.test(value.activeCharacterId), 'Active character ID is invalid.');
  assert(value.mode === 'direct' || value.mode === 'browser', 'Audio mode is invalid.');
  text(value.inputId, 1000, 'Input device', true); text(value.browserInputId, 1000, 'Browser input device', true);
  text(value.assistantUrl, 2048, 'Assistant URL');
  let url: URL; try { url = new URL(value.assistantUrl); } catch { throw new Error('Assistant URL must be a complete HTTPS or HTTP address.'); }
  assert((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password, 'Assistant URL must be an HTTPS or HTTP address without credentials.');
  number(value.overlayPort, 1024, 65535, 'Overlay port', true);
  object(value.detector, ['gain', 'openThresholdDb', 'closeThresholdDb', 'attackMs', 'releaseMs', 'holdMs'], 'Detector');
  const d = value.detector;
  number(d.gain, 0.1, 10, 'Gain'); number(d.openThresholdDb, -90, 0, 'Open threshold'); number(d.closeThresholdDb, -100, 0, 'Close threshold');
  assert(d.closeThresholdDb < d.openThresholdDb, 'Close threshold must be lower than open threshold.');
  for (const key of ['attackMs', 'releaseMs', 'holdMs']) number(d[key], 0, 5000, key);
}
function validateLibrary(value: unknown): asserts value is Library {
  object(value, ['version', 'token', 'characters', 'settings'], 'Library');
  assert(value.version === 1, 'Unsupported character library version.');
  assert(typeof value.token === 'string' && /^[0-9a-f]{64}$/.test(value.token), 'Overlay access token is invalid.');
  assert(Array.isArray(value.characters) && value.characters.length >= 1 && value.characters.length <= 100, 'Library must contain between 1 and 100 characters.');
  const ids = new Set<string>();
  for (const character of value.characters) { validateCharacter(character); assert(!ids.has(character.id), 'Character IDs must be unique.'); ids.add(character.id); }
  validateSettings(value.settings); assert(ids.has(value.settings.activeCharacterId), 'The active character does not exist.');
}
function validatePng(png: Buffer): void {
  assert(Buffer.isBuffer(png) && png.length >= 45 && png.length <= MAX_IMAGE_BYTES, 'PNG image must be between 45 bytes and 16 MB.');
  assert(png.subarray(0, 8).equals(PNG) && png.readUInt32BE(8) === 13 && png.toString('ascii', 12, 16) === 'IHDR', 'Image must be decoded and normalized to PNG before importing.');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert(width >= 1 && height >= 1 && width <= 8192 && height <= 8192 && width * height <= 32_000_000, 'Image exceeds the 8192 pixel / 32 megapixel limit.');
  assert(png.subarray(-8, -4).toString('ascii') === 'IEND', 'PNG image is incomplete.');
}

export class LibraryStore {
  private library?: Library;
  private assets = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  readonly filename: string;
  constructor(readonly dataDir: string, private legacyAssetsDir: string) { this.filename = path.join(dataDir, 'library.json'); }
  private serialized<T>(action: () => Promise<T>): Promise<T> { const next = this.queue.then(action); this.queue = next.catch(() => {}); return next; }
  snapshot(): Library { assert(this.library, 'Character library has not been loaded.'); return clone(this.library); }
  private diskPath(id: string, file: string): string { return path.join(this.dataDir, 'characters', id, 'assets', file); }
  assetPath(id: string, file: string): string | undefined {
    if (!ID.test(id) || !ASSET.test(file) || !this.assets.has(`${id}/${file}`)) return undefined;
    const filename = this.diskPath(id, file); return existsSync(filename) ? filename : undefined;
  }
  private async persist(next: Library): Promise<void> {
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, this.filename); this.library = clone(next); }
    catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error; }
  }
  async load(): Promise<Library> {
    return this.serialized(async () => {
      if (this.library) return this.snapshot();
      await fs.mkdir(this.dataDir, { recursive: true });
      let source: string;
      try { source = await fs.readFile(this.filename, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const id = randomUUID();
        const character: Character = { id, name: 'Studio character', width: 600, height: 600, closed: [], open: [], frameMs: 180 };
        for (const pose of ['closed', 'open'] as const) {
          const dir = path.join(this.legacyAssetsDir, `mouth_${pose}`);
          const files = (await fs.readdir(dir)).filter(name => /^\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          assert(files.length >= 1 && files.length <= 64, `Bundled ${pose}-mouth character artwork is missing or invalid.`);
          character[pose] = await this.importBuffers(id, await Promise.all(files.map(async name => ({ name, png: await fs.readFile(path.join(dir, name)) }))));
        }
        const initial: Library = { version: 1, token: randomBytes(32).toString('hex'), characters: [character], settings: { activeCharacterId: id, mode: 'direct', inputId: '', browserInputId: '', assistantUrl: 'https://app.sesame.com', overlayPort: 48241, detector: { ...DEFAULT_DETECTOR } } };
        validateLibrary(initial); await this.persist(initial); return this.snapshot();
      }
      try {
        const parsed: unknown = JSON.parse(source); validateLibrary(parsed);
        for (const character of parsed.characters) for (const sprite of [...character.closed, ...character.open]) {
          const filename = this.diskPath(character.id, sprite.file); const stat = await fs.lstat(filename); assert(stat.isFile() && !stat.isSymbolicLink(), `Character image ${sprite.name} is missing or invalid.`);
          assert(stat.size >= 45 && stat.size <= MAX_IMAGE_BYTES, `Character image ${sprite.name} has an invalid size.`); validatePng(await fs.readFile(filename)); this.assets.add(`${character.id}/${sprite.file}`);
        }
        this.library = clone(parsed); return this.snapshot();
      } catch (error) {
        const backup = `${this.filename}.invalid-${Date.now()}-${randomUUID()}.bak`;
        await fs.copyFile(this.filename, backup).catch(() => {});
        throw new Error(`Cannot load character library. Your original file was preserved at ${this.filename}; a recovery copy was attempted at ${backup}. ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
  async saveCharacter(character: Character): Promise<Library> {
    return this.serialized(async () => {
      validateCharacter(character); const next = this.snapshot();
      for (const sprite of [...character.closed, ...character.open]) assert(this.assetPath(character.id, sprite.file), `Image ${sprite.name} has not been imported for this character.`);
      const index = next.characters.findIndex(item => item.id === character.id);
      if (index >= 0) next.characters[index] = clone(character); else { assert(next.characters.length < 100, 'Character library is full.'); next.characters.push(clone(character)); }
      validateLibrary(next); await this.persist(next); return this.snapshot();
    });
  }
  async saveSettings(settings: AppSettings): Promise<Library> {
    return this.serialized(async () => { validateSettings(settings); const next = this.snapshot(); next.settings = clone(settings); validateLibrary(next); await this.persist(next); return this.snapshot(); });
  }
  async importImageBuffers(characterId: string, images: Array<{ name: string; png: Buffer }>): Promise<Sprite[]> { return this.serialized(() => this.importBuffers(characterId, images)); }
  private async importBuffers(characterId: string, images: Array<{ name: string; png: Buffer }>): Promise<Sprite[]> {
    assert(ID.test(characterId), 'Character ID must be a UUID.'); assert(Array.isArray(images) && images.length >= 1 && images.length <= 64, 'Import between 1 and 64 images at a time.');
    let total = 0;
    for (const image of images) { text(image.name, 200, 'Image name'); validatePng(image.png); total += image.png.length; }
    assert(total <= 128 * 1024 * 1024, 'An import may contain at most 128 MB of images.');
    const dir = path.join(this.dataDir, 'characters', characterId, 'assets'); await fs.mkdir(dir, { recursive: true });
    const written: string[] = []; const sprites: Sprite[] = [];
    try {
      for (const image of images) { const id = randomUUID(), file = `${id}.png`, filename = this.diskPath(characterId, file); await fs.writeFile(filename, image.png, { flag: 'wx' }); written.push(filename); sprites.push({ id, file, name: image.name, x: 0, y: 0, scale: 1 }); }
      for (const sprite of sprites) this.assets.add(`${characterId}/${sprite.file}`); return sprites;
    } catch (error) { await Promise.all(written.map(filename => fs.rm(filename, { force: true }).catch(() => {}))); throw error; }
  }
}
