import { app, BrowserWindow, WebContentsView, ipcMain, dialog, nativeImage, clipboard, session } from 'electron';
import type { IpcMainInvokeEvent, IpcMainEvent, Rectangle } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { LibraryStore } from './library';
import { OverlayServer } from './overlay';
import { runSmoke } from './smoke';
import { overlayUrl, VISEMES, VISEME_LABELS } from './shared';
import type { AppSettings, AvatarState, Bootstrap, BrowserStatus, Character, CharacterGenerationRequest, GenerationProgress } from './shared';
import { CharacterGenerationService, type GeneratedAtlas } from './character-generation';
import { compositeSpeechPixels, contextAroundRegion, fitSpriteToCanvas, padSpritePixels, regionToPixels, validFaceRegion, validMouthRegion } from './character-compositing';
import { createCharacterFixtureFetch, runCharacterCreationSmoke } from './character-creation-smoke';
import { runCharacterDeletionSmoke } from './character-deletion-smoke';

const smoke = process.argv.includes('--smoke-test');
const tabOnly = process.argv.includes('--tab-capture-only');
if (smoke) {
  app.setPath('userData', path.join(process.cwd(), '.qa', process.argv.includes('--character-delete-check') ? 'character-delete-profile' : 'profile'));
  if (!tabOnly) app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.disableHardwareAcceleration();
}
app.setName('Voxincarnate');
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);
let window: BrowserWindow;
let assistant: WebContentsView | undefined;
let store: LibraryStore;
let overlay: OverlayServer;
let overlayOrigin = '';
let browserEnabled = false;
let browserDeviceId = '';
let browserAllowedOrigin = '';
let browserVisible = false;
let shuttingDown = false;
const characterFixture = smoke && process.argv.includes('--character-suite-check');
const generator = new CharacterGenerationService(characterFixture ? { apiKey: 'character-suite-fixture', fetch: createCharacterFixtureFetch() } : {});
let sourceImage: { id: string; bytes: Buffer; name: string } | undefined;
let generationController: AbortController | undefined;
let generationTask: Promise<unknown> | undefined;
const generatedDrafts = new Set<string>();
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show(); window.focus();
});
const permissionTrace: unknown[] = [];

function bootstrap(): Bootstrap { return { ...store.snapshot(), overlayOrigin }; }
function trusted(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return event.sender === window?.webContents && event.senderFrame === window.webContents.mainFrame;
}
function assertTrusted(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!trusted(event)) throw new Error('This action is available only in the application.');
}
function status(value: BrowserStatus): void {
  if (!window?.isDestroyed()) window.webContents.send('browser:status', value);
}
function isAssistantUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return !u.username && !u.password && (u.protocol === 'https:' ||
      (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
  } catch { return false; }
}
function sendAssistant(type: 'devices' | 'input' | 'stop', deviceId?: string): void {
  if (assistant && !assistant.webContents.isDestroyed()) assistant.webContents.send('assistant:command', { type, deviceId });
}
function stopBrowserMic(): void {
  const hadAccess = browserEnabled;
  browserEnabled = false; sendAssistant('stop');
  // Destroying the page's document also closes cloned/iframe media tracks.
  if (hadAccess && !shuttingDown && assistant && !assistant.webContents.isDestroyed() && assistant.webContents.getURL()) assistant.webContents.reload();
}

async function readCharacterImage(file: string): Promise<{ name: string; png: Buffer; width: number; height: number }> {
  const info = await fs.stat(file);
  if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('Choose an image under 16 MB.');
  const bytes = await fs.readFile(file);
  if (!(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255))) throw new Error('Choose a PNG or JPEG image.');
  const image = nativeImage.createFromBuffer(bytes);
  const { width, height } = image.getSize();
  if (image.isEmpty() || width < 1 || height < 1 || width > 4096 || height > 4096) throw new Error('Use an image no larger than 4096 × 4096 pixels.');
  const png = image.toPNG();
  if (png.length > 16 * 1024 * 1024) throw new Error('The decoded image is too large. Resize it before importing.');
  return { name: path.basename(file).slice(0, 180), png, width, height };
}

/** Every atlas cell becomes a full-canvas PNG so mouth changes share one origin. */
function splitGeneratedAtlas(atlas: GeneratedAtlas, targetWidth = 512, targetHeight = 512, preserveAspect = false): Array<{ name: string; png: Buffer }> {
  const image = nativeImage.createFromBuffer(atlas.png);
  const { width, height } = image.getSize();
  if (image.isEmpty() || width < atlas.columns * 64 || height < atlas.rows * 64 || width > 4096 || height > 4096) {
    throw new Error('The generated sprite sheet could not be decoded. Generate again or import your artwork manually.');
  }
  return atlas.frames.map((name, index) => {
    const column = index % atlas.columns, row = Math.floor(index / atlas.columns);
    const x = Math.floor(column * width / atlas.columns), y = Math.floor(row * height / atlas.rows);
    const cell = image.crop({ x, y, width: Math.floor((column + 1) * width / atlas.columns) - x,
      height: Math.floor((row + 1) * height / atlas.rows) - y });
    if (!preserveAspect) return { name: `${name}.png`, png: cell.resize({ width: targetWidth, height: targetHeight, quality: 'best' }).toPNG() };
    const cellSize = cell.getSize();
    const fitted = fitSpriteToCanvas(cellSize.width, cellSize.height, targetWidth, targetHeight);
    const bitmap = cell.resize({ width: fitted.width, height: fitted.height, quality: 'best' }).toBitmap();
    const pixels = padSpritePixels(bitmap, targetWidth, targetHeight, fitted);
    return { name: `${name}.png`, png: nativeImage.createFromBitmap(Buffer.from(pixels), { width: targetWidth, height: targetHeight }).toPNG() };
  });
}

/** Repeat the exact source context rather than asking the model to invent a sheet layout. */
function speechTemplate(original: Electron.NativeImage, region: Rectangle) {
  const { width, height } = original.getSize();
  const context = contextAroundRegion(region, width, height);
  const side = Math.max(context.width, context.height);
  const padX = Math.floor((side - context.width) / 2), padY = Math.floor((side - context.height) / 2);
  const square = Buffer.alloc(side * side * 4);
  const crop = original.crop(context).toBitmap();
  for (let y = 0; y < context.height; y++) crop.copy(square, ((padY + y) * side + padX) * 4, y * context.width * 4, (y + 1) * context.width * 4);
  const reference = nativeImage.createFromBitmap(square, { width: side, height: side });
  const patchRegion = { x: region.x - context.x + padX, y: region.y - context.y + padY, width: region.width, height: region.height };
  const editRegion = { x: patchRegion.x / side, y: patchRegion.y / side, width: region.width / side, height: region.height / side };
  const size = 1024, sheet = Buffer.alloc(size * size * 4), mask = Buffer.alloc(size * size * 4, 255);
  for (let index = 0; index < 9; index++) {
    const column = index % 3, row = Math.floor(index / 3);
    const left = Math.floor(column * size / 3), top = Math.floor(row * size / 3);
    const cellWidth = Math.floor((column + 1) * size / 3) - left, cellHeight = Math.floor((row + 1) * size / 3) - top;
    const cell = reference.resize({ width: cellWidth, height: cellHeight, quality: 'best' }).toBitmap();
    for (let y = 0; y < cellHeight; y++) {
      cell.copy(sheet, ((top + y) * size + left) * 4, y * cellWidth * 4, (y + 1) * cellWidth * 4);
      if (index === 8) continue; // Rest is protected in the request and restored exactly afterward.
      for (let x = 0; x < cellWidth; x++) {
        const dx = ((x + .5) / cellWidth - editRegion.x - editRegion.width / 2) / (editRegion.width / 2);
        const dy = ((y + .5) / cellHeight - editRegion.y - editRegion.height / 2) / (editRegion.height / 2);
        if (dx * dx + dy * dy < 1) mask.fill(0, ((top + y) * size + left + x) * 4, ((top + y) * size + left + x) * 4 + 4);
      }
    }
  }
  return { side, patchRegion, editRegion,
    image: nativeImage.createFromBitmap(sheet, { width: size, height: size }).toPNG(),
    mask: nativeImage.createFromBitmap(mask, { width: size, height: size }).toPNG() };
}

async function generateCharacter(request: CharacterGenerationRequest): Promise<Character> {
  if (generationController) throw new Error('A character is already being generated. Wait or cancel it first.');
  if (store.snapshot().characters.length >= 100) throw new Error('The character library is full.');
  if (!request || typeof request.name !== 'string' || !request.name.trim() || request.name.length > 120 || /[\u0000-\u001f]/.test(request.name)) throw new Error('Enter a character name under 120 characters.');
  if (request.sourceId !== undefined && (typeof request.sourceId !== 'string' || request.sourceId !== sourceImage?.id)) throw new Error('Choose your source image again.');
  for (const key of ['description', 'style'] as const) if (request[key] !== undefined && (typeof request[key] !== 'string' || request[key]!.length > 4000)) throw new Error('Keep the character description and style under 4000 characters each.');
  for (const key of ['entranceSide', 'exitSide'] as const) if (request[key] !== undefined && !['left', 'right'].includes(request[key]!)) throw new Error('Choose the left or right edge.');
  for (const key of ['entranceEffect', 'exitEffect'] as const) if (request[key] !== undefined && !['walk', 'smoke', 'fall-jump'].includes(request[key]!)) throw new Error('Choose a supported entrance or exit.');
  if (request.speechMode !== undefined && !['mouth', 'face'].includes(request.speechMode)) throw new Error('Choose mouth animation or face expressions.');
  if (request.mouthRegion !== undefined && !validMouthRegion(request.mouthRegion)) throw new Error('Choose a mouth area within the image, covering no more than 25% of it.');
  if (request.faceRegion !== undefined && !validFaceRegion(request.faceRegion)) throw new Error('Choose a face area within the image, covering no more than 65% of it.');
  if (!request.sourceId && !request.description?.trim()) throw new Error('Choose an image or describe a character first.');
  if (!generator.configured) throw new Error('OpenAI is unavailable. Set OPENAI_API_KEY in the environment and restart Voxincarnate. You can still build a character manually.');
  const controller = new AbortController(); generationController = controller;
  const id = randomUUID();
  const source = request.sourceId ? sourceImage!.bytes : undefined;
  const entranceEffect = request.entranceEffect || 'walk', exitEffect = request.exitEffect || 'walk';
  const entranceSide = request.entranceSide || 'right', exitSide = request.exitSide || entranceSide;
  const walkKinds = (['enter', 'exit'] as const).filter(kind => (kind === 'enter' ? entranceEffect : exitEffect) === 'walk');
  const total = (source ? 0 : 2) + (!request.mouthRegion || (request.speechMode === 'face' && !request.faceRegion) ? 1 : 0) + 2 + walkKinds.length;
  let completed = 0;
  const progress = (stage: string) => {
    if (characterFixture) console.log(`[character fixture] ${stage}`);
    const update: GenerationProgress = { stage, completed: completed++, total };
    if (!window.isDestroyed()) window.webContents.send('generation:progress', update);
  };
  try {
    let bytes = source;
    const details = [request.description, request.style].filter(Boolean).join('\n');
    if (!bytes) {
      progress('Designing your character');
      const concept = await generator.generateConcept(details, controller.signal);
      progress('Generating the reference image');
      bytes = await generator.generateSource(concept.imagePrompt, controller.signal);
    }
    const original = nativeImage.createFromBuffer(bytes);
    const { width, height } = original.getSize();
    if (original.isEmpty() || width < 64 || height < 64 || width > 4096 || height > 4096) throw new Error('Use a reference between 64 and 4096 pixels per dimension.');
    const speechMode = request.speechMode || 'mouth';
    let mouthRegion = request.mouthRegion, faceRegion = request.faceRegion;
    if (!mouthRegion || (speechMode === 'face' && !faceRegion)) {
      progress('Locating the face, eyes, and mouth');
      const detected = await generator.detectSpeechRegions({ bytes, mimeType: 'image/png' }, controller.signal);
      mouthRegion ||= detected.mouthRegion; faceRegion ||= detected.faceRegion;
    }
    const epsilon = .000001;
    if (speechMode === 'face' && (!faceRegion || mouthRegion.x < faceRegion.x - epsilon || mouthRegion.y < faceRegion.y - epsilon ||
      mouthRegion.x + mouthRegion.width > faceRegion.x + faceRegion.width + epsilon || mouthRegion.y + mouthRegion.height > faceRegion.y + faceRegion.height + epsilon)) {
      throw new Error('Keep the mouth selection inside the face area.');
    }
    const region = regionToPixels(speechMode === 'face' ? faceRegion! : mouthRegion, width, height, speechMode === 'face' ? .65 : .25);
    if (region.width < 4 || region.height < 4) throw new Error('Select a mouth area at least 4 pixels wide and high.');
    progress(speechMode === 'face' ? 'Creating subtle face expressions while protecting the character' : 'Creating mouth shapes with facial context');
    const template = speechTemplate(original, region);
    const mouthAtlas = await generator.generateMouthAtlas({ bytes: template.image, mimeType: 'image/png' }, details, controller.signal,
      speechMode, template.editRegion, { bytes: template.mask, mimeType: 'image/png' });
    const walks = walkKinds.length ? await generator.generateWalkAtlases({ bytes, mimeType: 'image/png' }, details, {
      signal: controller.signal, kinds: walkKinds,
      onProgress: stage => progress(stage === 'enter' ? 'Creating the walk-in animation' : 'Creating the walk-out animation')
    }) : {};
    controller.signal.throwIfAborted();
    progress('Preparing your character for review');
    const base = original.toBitmap();
    const mouthImages = splitGeneratedAtlas(mouthAtlas, template.side, template.side).map((image, index) => {
      if (VISEMES[index] === 'X') return { name: 'X · Original artwork.png', png: original.toPNG() };
      const patch = nativeImage.createFromBuffer(image.png).crop(template.patchRegion).toBitmap();
      const pixels = compositeSpeechPixels(base, patch, width, height, region, true);
      return { name: `${VISEMES[index]} · Mouth edit.png`, png: nativeImage.createFromBitmap(Buffer.from(pixels), { width, height }).toPNG() };
    });
    const enterImages = walks.enter ? splitGeneratedAtlas(walks.enter, width, height, true).map((image, i) => ({ ...image, name: `Walk in ${i + 1}.png` })) : [];
    const exitImages = walks.exit ? splitGeneratedAtlas(walks.exit, width, height, true).map((image, i) => ({ ...image, name: `Walk out ${i + 1}.png` })) : [];
    const images = [...mouthImages, { ...mouthImages[8], name: 'Closed fallback.png' }, { ...mouthImages[3], name: 'Open fallback.png' },
      ...enterImages, ...exitImages];
    const sprites = await store.importImageBuffers(id, images);
    controller.signal.throwIfAborted();
    const character: Character = { id, name: request.name.trim(), width, height, frameMs: 120,
      animationMode: 'viseme', closed: [sprites[9]], open: [sprites[10]],
      visemes: Object.fromEntries(VISEMES.map((pose, index) => [pose, [sprites[index]]])),
      motions: { enter: { frames: sprites.slice(11, 11 + enterImages.length), frameMs: 120, durationMs: entranceEffect === 'walk' ? 1800 : 1000, side: entranceSide, effect: entranceEffect, facing: 'right' },
        exit: { frames: sprites.slice(11 + enterImages.length), frameMs: 120, durationMs: exitEffect === 'walk' ? 1800 : 1000, side: exitSide, effect: exitEffect, facing: 'right' } } };
    generatedDrafts.add(id);
    return character;
  } catch (error) {
    await store.discardCharacterDraft(id).catch(() => undefined);
    if (controller.signal.aborted) throw new Error('Generation cancelled. Requests already sent to OpenAI may still be billed.');
    throw error;
  } finally { if (generationController === controller) generationController = undefined; }
}

function createAssistant(): WebContentsView {
  if (assistant && !assistant.webContents.isDestroyed()) return assistant;
  const ses = session.fromPartition('persist:assistant');
  // The remote site may request its microphone only while browser mode is enabled.
  ses.setPermissionCheckHandler((wc, permission, origin, details) =>
    wc === assistant?.webContents && browserEnabled && permission === 'media' && details.isMainFrame === true && details.mediaType === 'audio' && isAssistantUrl(origin) && (!browserAllowedOrigin || new URL(origin).origin === browserAllowedOrigin));
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(wc === assistant?.webContents && browserEnabled && permission === 'media' && details.isMainFrame === true &&
      isAssistantUrl(details.requestingUrl) && (!browserAllowedOrigin || new URL(details.requestingUrl).origin === browserAllowedOrigin) && !!media?.length && media.every(t => t === 'audio'));
  });
  ses.setDisplayMediaRequestHandler((_request, callback) => callback(null));
  const view = new WebContentsView({ webPreferences: {
    session: ses, preload: path.join(__dirname, 'assistant-preload.cjs'),
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    backgroundThrottling: false, webSecurity: true
  } });
  assistant = view;
  view.setBackgroundColor('#171c20');
  view.setVisible(false);
  window.contentView.addChildView(view);
  view.webContents.setWindowOpenHandler(({ url }) => {
    if (isAssistantUrl(url)) void view.webContents.loadURL(url).catch(e => status({ url, error: e.message }));
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (!isAssistantUrl(url)) { event.preventDefault(); return; }
    if (browserAllowedOrigin && new URL(url).origin !== browserAllowedOrigin) {
      browserEnabled = false; browserDeviceId = ''; browserAllowedOrigin = '';
      status({ url, devices: [], actualInput: '', message: 'Choose a microphone for this website before connecting voice.' });
    }
  });
  view.webContents.on('did-start-loading', () => status({ url: view.webContents.getURL(), loading: true }));
  view.webContents.on('did-stop-loading', () => {
    status({ url: view.webContents.getURL(), loading: false });
  });
  view.webContents.on('did-navigate-in-page', (_, url) => status({ url }));
  view.webContents.on('did-fail-load', (_, code, description, url, isMainFrame) => {
    if (isMainFrame && code !== -3) status({ url, loading: false, error: `${description}. Check the URL and reload.` });
  });
  view.webContents.on('render-process-gone', () => {
    stopBrowserMic();
    status({ url: '', error: 'The assistant browser stopped. Reload it to reconnect.' });
  });
  return view;
}

function handlers(): void {
  ipcMain.handle('app:bootstrap', e => { assertTrusted(e); return bootstrap(); });
  ipcMain.handle('app:copy', (e, text) => {
    assertTrusted(e); if (typeof text !== 'string' || text.length > 8192) throw new Error('Invalid text.');
    clipboard.writeText(text);
  });
  ipcMain.handle('character:save', async (e, character: Character) => {
    assertTrusted(e); await store.saveCharacter(character); generatedDrafts.delete(character.id); overlay.refresh(); return bootstrap();
  });
  ipcMain.handle('character:delete', async (e, id: string) => {
    assertTrusted(e); await store.deleteCharacter(id); overlay.refresh(); return bootstrap();
  });
  ipcMain.handle('generation:availability', e => {
    assertTrusted(e);
    return { available: generator.configured, imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5', textModel: process.env.OPENAI_TEXT_MODEL || 'gpt-4.1-mini' };
  });
  ipcMain.handle('generation:source', async e => {
    assertTrusted(e);
    if (generationController) throw new Error('Wait for generation to finish before changing the reference.');
    let image: { name: string; png: Buffer; width: number; height: number };
    if (characterFixture) {
      const fixture = nativeImage.createFromBuffer(await generator.generateSource('Deterministic test reference'));
      image = { name: 'Fixture character.png', png: fixture.toPNG(), ...fixture.getSize() };
    } else {
      const result = await dialog.showOpenDialog(window, { title: 'Choose one character reference', properties: ['openFile'],
        filters: [{ name: 'Character image', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (result.canceled || !result.filePaths[0]) return;
      image = await readCharacterImage(result.filePaths[0]);
    }
    sourceImage = { id: randomUUID(), bytes: image.png, name: image.name };
    const preview = nativeImage.createFromBuffer(image.png).resize({ width: Math.min(image.width, 600) });
    return { id: sourceImage.id, name: image.name, width: image.width, height: image.height, previewUrl: preview.toDataURL() };
  });
  ipcMain.handle('generation:create', async (e, request: CharacterGenerationRequest) => {
    assertTrusted(e);
    if (generationTask) throw new Error('A character is already being generated. Wait or cancel it first.');
    const task = generateCharacter(request); generationTask = task;
    try { return await task; } finally { if (generationTask === task) generationTask = undefined; }
  });
  ipcMain.handle('generation:detect-face', async (e, sourceId: string) => {
    assertTrusted(e);
    if (generationController || generationTask) throw new Error('Wait for the current generation step to finish.');
    if (typeof sourceId !== 'string' || sourceId !== sourceImage?.id) throw new Error('Choose your source image again.');
    if (!generator.configured) throw new Error('OpenAI is unavailable. You can choose the mouth area manually.');
    const controller = new AbortController(); generationController = controller;
    const task = generator.detectSpeechRegions({ bytes: sourceImage.bytes, mimeType: 'image/png' }, controller.signal);
    generationTask = task;
    try {
      const detected = await task;
      controller.signal.throwIfAborted();
      return detected;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('Face detection cancelled.');
      throw error;
    } finally {
      if (generationController === controller) generationController = undefined;
      if (generationTask === task) generationTask = undefined;
    }
  });
  ipcMain.handle('generation:cancel', e => { assertTrusted(e); generationController?.abort(); });
  ipcMain.handle('generation:discard', async (e, id: string) => {
    assertTrusted(e); await store.discardCharacterDraft(id); generatedDrafts.delete(id);
  });
  ipcMain.handle('character:presence', (e, id: string, visible: boolean) => { assertTrusted(e); return overlay.setPresence(id, visible); });
  ipcMain.handle('character:demo', async e => {
    assertTrusted(e);
    await store.createVisemeDemo(path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'artwork', 'viseme-demo'));
    overlay.refresh(); return bootstrap();
  });
  ipcMain.handle('settings:save', async (e, settings: AppSettings) => {
    assertTrusted(e);
    if (settings.overlayPort !== store.snapshot().settings.overlayPort) throw new Error('Changing the overlay port requires a restart.');
    await store.saveSettings(settings); if (settings.mode === 'direct') stopBrowserMic();
    overlay.refresh(); return bootstrap();
  });
  ipcMain.handle('character:import', async (e, characterId: string, pose: string) => {
    assertTrusted(e); if (!['open', 'closed', 'enter', 'exit', ...VISEMES].includes(pose)) throw new Error('Choose a mouth pose or walking clip.');
    const label = pose === 'enter' ? 'walk-in' : pose === 'exit' ? 'walk-out' : pose === 'open' || pose === 'closed' ? `${pose}-mouth` : `${pose} (${VISEME_LABELS[pose as keyof typeof VISEME_LABELS]})`;
    const result = await dialog.showOpenDialog(window, { title: `Add ${label} images`,
      properties: ['openFile', 'multiSelections'], filters: [{ name: 'Character images', extensions: ['png', 'jpg', 'jpeg'] }] });
    if (result.canceled) return [];
    if (result.filePaths.length > 24) throw new Error('Import up to 24 images at a time.');
    const images = [];
    for (const file of result.filePaths) {
      const info = await fs.stat(file);
      if (info.size > 16 * 1024 * 1024) throw new Error(`${path.basename(file)} exceeds 16 MB. Resize it and try again.`);
      const data = await fs.readFile(file);
      if (!(data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
        (data[0] === 255 && data[1] === 216 && data[2] === 255))) throw new Error('Use PNG or JPEG images.');
      const image = nativeImage.createFromBuffer(data);
      const { width, height } = image.getSize();
      if (image.isEmpty() || width < 1 || height < 1 || width > 4096 || height > 4096) {
        throw new Error(`${path.basename(file)} could not be decoded or exceeds 4096 pixels. Resize it and try again.`);
      }
      images.push({ name: path.basename(file), png: image.toPNG() });
    }
    return store.importImageBuffers(characterId, images);
  });
  ipcMain.on('audio:state', (e, input: Omit<AvatarState, 'sequence' | 'timestamp'>) => {
    if (trusted(e)) overlay.publish(input);
  });
  ipcMain.on('assistant:bootstrap', e => {
    e.returnValue = { enabled: e.sender === assistant?.webContents && browserEnabled,
      deviceId: e.sender === assistant?.webContents ? browserDeviceId : '' };
  });
  ipcMain.on('assistant:status', (e, value: Partial<BrowserStatus>) => {
    if (e.sender !== assistant?.webContents || !value || typeof value !== 'object') return;
    // Remote messages are diagnostics only; they never invoke application actions.
    const bounded = (s: unknown) => typeof s === 'string' ? s.slice(0, 300) : undefined;
    const devices = Array.isArray(value.devices) ? value.devices.slice(0, 100).filter(d =>
      d && typeof d.deviceId === 'string' && typeof d.label === 'string').map(d =>
      ({ deviceId: d.deviceId.slice(0, 512), label: d.label.slice(0, 200) })) : undefined;
    const update: BrowserStatus = { url: e.sender.getURL() };
    if (devices) update.devices = devices;
    for (const key of ['actualInput', 'error', 'message'] as const) {
      const text = bounded(value[key]); if (text !== undefined) update[key] = text;
    }
    status(update);
  });
  ipcMain.handle('browser:action', async (e, action: string, value?: string) => {
    assertTrusted(e);
    if (action === 'stop') { stopBrowserMic(); return; }
    const view = createAssistant();
    if (action === 'navigate') {
      if (!value || !isAssistantUrl(value)) throw new Error('Enter an HTTPS website or a local HTTP address.');
      stopBrowserMic();
      await view.webContents.loadURL(value);
    } else if (action === 'back') { if (view.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack(); }
    else if (action === 'forward') { if (view.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward(); }
    else if (action === 'reload') view.webContents.reload();
    else if (action === 'devices') {
      if (!isAssistantUrl(view.webContents.getURL())) throw new Error('Open the assistant website before enabling its microphone.');
      browserAllowedOrigin = new URL(view.webContents.getURL()).origin;
      browserEnabled = true; sendAssistant('devices');
    } else if (action === 'input') {
      if (typeof value !== 'string' || !value || value.length > 512) throw new Error('Choose the assistant microphone first.');
      if (!isAssistantUrl(view.webContents.getURL())) throw new Error('Open the assistant website before connecting voice.');
      browserAllowedOrigin = new URL(view.webContents.getURL()).origin;
      browserDeviceId = value; browserEnabled = true; sendAssistant('input', value);
    } else throw new Error('Unknown browser action.');
  });
  ipcMain.on('browser:bounds', (e, bounds) => {
    if (!trusted(e) || !bounds) return;
    const view = createAssistant();
    const size = window.getContentBounds();
    const rect: Rectangle = { x: Math.max(0, Math.round(Number(bounds.x) || 0)), y: Math.max(0, Math.round(Number(bounds.y) || 0)),
      width: Math.max(0, Math.min(size.width, Math.round(Number(bounds.width) || 0))),
      height: Math.max(0, Math.min(size.height, Math.round(Number(bounds.height) || 0))) };
    browserVisible = bounds.visible === true;
    view.setBounds(rect); view.setVisible(browserVisible);
  });
}

async function main(): Promise<void> {
  await app.whenReady();
  store = new LibraryStore(app.getPath('userData'), app.isPackaged ? path.join(process.resourcesPath, 'legacy-artwork') : path.join(process.cwd(), 'overlays'));
  await store.load();
  overlay = new OverlayServer(store); overlayOrigin = await overlay.start();
  window = new BrowserWindow({ title: 'Voxincarnate', width: 1440, height: 960, minWidth: 1120, minHeight: 740,
    show: !smoke, backgroundColor: '#11171b', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true,
      nodeIntegration: false, backgroundThrottling: false, webSecurity: true, offscreen: smoke } });
  handlers();
  const localSession = window.webContents.session;
  localSession.setPermissionCheckHandler((wc, permission, origin, details) => {
    if (smoke) permissionTrace.push({ check: permission, origin, details });
    return wc === window.webContents && ((permission === 'media' && details.mediaType === 'audio') || permission === 'display-capture');
  });
  localSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const media = (details as { mediaTypes?: string[] }).mediaTypes;
    if (smoke) permissionTrace.push({ request: permission, details });
    callback(wc === window.webContents && (permission === 'display-capture' ||
      (permission === 'media' && !!media && (media.length ? media.every(t => t === 'audio') : browserEnabled))));
  });
  localSession.setDisplayMediaRequestHandler((request, callback) => {
    const target = assistant?.webContents;
    if (smoke) permissionTrace.push({ display: true, sameFrame: request.frame === window.webContents.mainFrame, target: !!target, browserEnabled });
    if (request.frame === window.webContents.mainFrame && target && !target.isDestroyed() && browserEnabled) {
      callback({ video: target.mainFrame, audio: target.mainFrame, enableLocalEcho: true });
    } else callback(null);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // A document reload/crash cannot leave a paid job running without its review UI.
  const abandonGeneration = () => {
    generationController?.abort();
    for (const id of generatedDrafts) void store.discardCharacterDraft(id).then(() => generatedDrafts.delete(id)).catch(() => undefined);
  };
  window.webContents.on('did-navigate', abandonGeneration);
  window.webContents.on('render-process-gone', abandonGeneration);
  window.webContents.on('destroyed', abandonGeneration);
  window.webContents.on('will-navigate', e => e.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
    if (smoke) { event.preventDefault(); return; }
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['Keep editing', 'Discard and close'], defaultId: 0, cancelId: 0,
      title: 'Unsaved changes', message: 'Discard your unsaved character or settings changes?' });
    if (choice === 1) event.preventDefault();
  });
  window.on('closed', () => { if (assistant && !assistant.webContents.isDestroyed()) assistant.webContents.close(); app.quit(); });
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (smoke) await smokeTest();
}

async function smokeTest(): Promise<void> {
  const output = path.join(process.cwd(), '.qa'); await fs.mkdir(output, { recursive: true });
  if (process.argv.includes('--character-delete-check')) {
    const result = await runCharacterDeletionSmoke(window, output);
    const report = path.join(output, 'character-deletion.json');
    await fs.writeFile(report, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, report }));
    app.exit(result.ok ? 0 : 1);
    return;
  }
  const result = await runSmoke({ window, createAssistant, setEnabled: value => { browserEnabled = value; browserAllowedOrigin = ''; },
    sendAssistant, overlayOrigin, bootstrap, outputDir: output, tabOnly });
  if (characterFixture) {
    result.characterCreation = await runCharacterCreationSmoke(window, output);
    if (!(result.characterCreation as { ok: boolean }).ok) result.ok = false;
  }
  let source: BrowserWindow | undefined;
  const overlayConsole: string[] = [];
  try {
    const data = bootstrap();
    source = new BrowserWindow({ show: false, width: 600, height: 600, transparent: true, backgroundColor: '#00000000',
      webPreferences: { partition: 'smoke-obs', sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    source.webContents.on('console-message', event => overlayConsole.push(event.message));
    await source.loadURL(overlayUrl(data, data.settings.activeCharacterId));
    await source.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{if([...document.images].some(i=>i.complete&&i.naturalWidth&&getComputedStyle(i).display==='block'))resolve(true);else if(n++>100)reject(new Error('Overlay artwork did not appear'));else setTimeout(tick,50)};tick()})`);
    const rendered = await source.webContents.capturePage();
    const pixels = rendered.toBitmap();
    const alpha = pixels[3];
    await fs.writeFile(path.join(output, 'obs-overlay.png'), rendered.toPNG());
    if (alpha !== 0) throw new Error('The overlay corner was not transparent.');
    result.overlay = { ok: true, alphaAtCorner: alpha, width: rendered.getSize().width, height: rendered.getSize().height };
    const demo = [...data.characters].reverse().find(character => character.animationMode === 'viseme' && VISEMES.every(pose => character.visemes?.[pose]?.length));
    if (!demo) throw new Error('The lip-sync demo was not available for the OBS rendering check.');
    await source.loadURL(overlayUrl(data, demo.id));
    const expectPose = async (pose: typeof VISEMES[number]) => {
      const file = demo.visemes![pose]![0].file;
      await source!.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{const image=[...document.images].find(i=>getComputedStyle(i).display==='block');if(image?.src.includes(${JSON.stringify(file)}))resolve(true);else if(n++>80)reject(new Error('OBS pose ${pose} did not render'));else setTimeout(tick,20)};tick()})`);
    };
    let audioTimeMs = 0;
    for (const pose of VISEMES) {
      overlay.publish({ characterId: demo.id, level: .2, db: -14, speaking: true, running: true,
        articulation: { weights: { [pose]: 1 }, audioTimeMs: audioTimeMs += 100 } });
      await expectPose(pose);
      const frame = await source.webContents.capturePage();
      if (frame.toBitmap()[3] !== 0) throw new Error(`OBS pose ${pose} lost transparent corner alpha.`);
      await fs.writeFile(path.join(output, `obs-viseme-${pose}.png`), frame.toPNG());
    }
    overlay.publish({ characterId: demo.id, level: .2, db: -14, speaking: true, running: true,
      articulation: { weights: { D: 1 }, audioTimeMs: audioTimeMs += 100 } });
    overlay.publish({ characterId: demo.id, level: .2, db: -14, speaking: true, running: true,
      articulation: { weights: { A: 1 }, audioTimeMs: audioTimeMs += 10 } });
    await expectPose('A');
    overlay.publish({ characterId: demo.id, level: 0, db: -100, speaking: false, running: false });
    await expectPose('X');
    result.overlayVisemes = { ok: true, distinctPoses: VISEMES.length, alphaAtCorner: 0, closureInterruptedOpening: true, stoppedToRest: true };
  } catch (error) {
    result.ok = false;
    let state: unknown;
    try { state = await source?.webContents.executeJavaScript(`({url:location.href,body:document.body.innerHTML,visibility:document.visibilityState,frames:[...document.images].map(i=>({src:i.src,complete:i.complete,width:i.naturalWidth,display:getComputedStyle(i).display}))})`); } catch {}
    result.overlay = { ok: false, error: String(error), console: overlayConsole, state };
  }
  finally { if (source && !source.isDestroyed()) source.destroy(); }
  if (process.argv.includes('--sesame-page-check')) {
    try {
      const view = createAssistant(); browserEnabled = false;
      view.setBounds({ x: 0, y: 0, width: 900, height: 600 }); view.setVisible(true);
      await view.webContents.loadURL('https://app.sesame.com/');
      const text = await view.webContents.executeJavaScript(`new Promise((resolve,reject)=>{let n=0;const tick=()=>{const text=document.body.innerText;if(/Welcome|Log in|Sesame/i.test(text))resolve(text);else if(n++>100)reject(new Error('Sesame setup did not become visible: '+text));else setTimeout(tick,100)};tick()})`);
      if (!/Welcome|Log in|Sesame/i.test(text)) throw new Error('Sesame setup content was not visible.');
      result.sesamePublicPage = { ok: true, url: view.webContents.getURL(), text: text.slice(0, 1500), voiceSessionStarted: false };
      try {
        await fs.writeFile(path.join(output, 'sesame-public.png'), (await view.webContents.capturePage()).toPNG());
      } catch (error) { (result.sesamePublicPage as Record<string, unknown>).screenshotUnavailable = String(error); }
      await view.webContents.loadURL('about:blank');
    } catch (error) { result.ok = false; result.sesamePublicPage = { ok: false, error: String(error) }; }
  }
  result.permissions = permissionTrace;
  await fs.writeFile(path.join(output, tabOnly ? 'smoke-tab.json' : 'smoke.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ok: result.ok, report: path.join(output, tabOnly ? 'smoke-tab.json' : 'smoke.json') }));
  app.exit(result.ok ? 0 : 1);
}

app.on('before-quit', event => {
  generationController?.abort();
  if (shuttingDown || !overlay || smoke) return;
  event.preventDefault(); shuttingDown = true; stopBrowserMic();
  // Wait for an aborted import to finish its queued rollback before ending the process.
  void Promise.allSettled([overlay.stop(), ...(generationTask ? [generationTask] : []),
    ...[...generatedDrafts].map(id => store.discardCharacterDraft(id))]).finally(() => app.quit());
});
void main().catch(error => {
  console.error(error);
  if (!smoke) dialog.showErrorBox('Voxincarnate could not start', `${error.message}\nClose another running copy or check that the application data folder is writable.`);
  app.exit(1);
});
