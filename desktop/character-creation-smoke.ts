import { app, nativeImage, type BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VISEMES, characterSprites, type AppSettings, type Character } from './shared';
import { regionToPixels } from './character-compositing';
import { hasMotion } from './character-motions';

const fixtureMouthRegion = { x: .4, y: .27, width: .2, height: .08 };
const fixtureFaceRegion = { x: .33, y: .08, width: .34, height: .34 };
const fixtureImages = new Map<string, string>();
const fixtureRequests = { concepts: 0, mouthDetections: 0, sourceImages: 0, mouthAtlases: 0, mouthCropUploads: 0, walkAtlases: 0 };
let failWalkingAfter: number | undefined;
let holdNextWalking = false;
function fixtureAtlas(grid: number, variant: number): string {
  const key = `${grid}:${variant}`;
  if (fixtureImages.has(key)) return fixtureImages.get(key)!;
  const size = 1024;
  const pixels = Buffer.alloc(size * size * 4);
  const colors = [[90, 205, 174], [231, 161, 87], [126, 173, 238], [223, 127, 154], [193, 157, 230], [216, 201, 101], [105, 195, 220], [228, 155, 201], [149, 201, 135]];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const column = Math.min(grid - 1, Math.floor(x * grid / size));
    const row = Math.min(grid - 1, Math.floor(y * grid / size));
    const cell = row * grid + column;
    const left = Math.floor(column * size / grid), top = Math.floor(row * size / grid);
    const width = Math.floor((column + 1) * size / grid) - left;
    const height = Math.floor((row + 1) * size / grid) - top;
    const localX = (x - left) / width, localY = (y - top) / height;
    const head = ((localX - .5) / .17) ** 2 + ((localY - .25) / .17) ** 2 < 1;
    const torso = localX > .32 && localX < .68 && localY > .4 && localY < .69;
    const gait = grid === 2 ? ((cell % 2) ? .035 : -.035) : 0;
    const legs = localY > .68 && localY < .92 && ((localX > .34 + gait && localX < .46 + gait) || (localX > .54 - gait && localX < .66 - gait));
    const arms = localY > .43 && localY < .69 && ((localX > .23 && localX < .31) || (localX > .69 && localX < .77));
    if (!head && !torso && !legs && !arms) continue;
    let color = colors[(cell + variant) % colors.length];
    const eyes = localY > .205 && localY < .235 && ((localX > .415 && localX < .445) || (localX > .555 && localX < .585));
    const mouth = localX > .44 && localX < .56 && localY > .285 && localY < .298 + (cell % 5) * .008;
    if (eyes || mouth) color = [25, 37, 46];
    const offset = (y * size + x) * 4;
    pixels[offset] = color[2]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[0]; pixels[offset + 3] = 255;
  }
  const png = nativeImage.createFromBitmap(pixels, { width: size, height: size }).toPNG().toString('base64');
  fixtureImages.set(key, png); return png;
}

/** Deterministic local API fixture. Never forwards a request or reads a real credential. */
export function createCharacterFixtureFetch(): typeof fetch {
  if (!process.argv.includes('--smoke-test') || !process.argv.includes('--character-suite-check')) {
    throw new Error('Character API fixtures require the isolated character-suite smoke flags.');
  }
  return async (input, init) => {
    if (init?.signal?.aborted) throw new DOMException('Fixture cancelled.', 'AbortError');
    const url = new URL(String(input));
    if (url.origin !== 'https://api.openai.com' || init?.method !== 'POST') throw new Error('Unexpected character fixture request.');
    if (url.pathname === '/v1/responses') {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      const locatingMouth = body?.text?.format?.name === 'character_speech_regions';
      if (!locatingMouth && body?.text?.format?.name !== 'character_concept') throw new Error('Unexpected character fixture response schema.');
      if (locatingMouth) fixtureRequests.mouthDetections++; else fixtureRequests.concepts++;
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(locatingMouth ? {
        faceRegion: fixtureFaceRegion, mouthRegion: fixtureMouthRegion, leftEye: { x: .43, y: .22 }, rightEye: { x: .57, y: .22 }, confidence: 'high'
      } : {
        name: 'Fixture robot', description: 'A friendly robot used for isolated UI validation.',
        imagePrompt: 'A front-facing full-body friendly robot with transparent padding.'
      }) }] }] });
    }
    let encoded: string;
    if (url.pathname === '/v1/images/generations') { fixtureRequests.sourceImages++; encoded = fixtureAtlas(1, 0); }
    else if (url.pathname === '/v1/images/edits' && init?.body instanceof FormData) {
      const prompt = String(init.body.get('prompt'));
      const mouthPatch = /3\s*by\s*3/i.test(prompt) && init.body.has('mask');
      if (mouthPatch) {
        const upload = init.body.get('image[]');
        if (!(upload instanceof Blob)) throw new Error('Mouth fixture did not receive its isolated crop.');
        const crop = nativeImage.createFromBuffer(Buffer.from(await upload.arrayBuffer()));
        const maskUpload = init.body.get('mask');
        if (!(maskUpload instanceof Blob)) throw new Error('Speech template did not include its edit mask.');
        const maskImage = nativeImage.createFromBuffer(Buffer.from(await maskUpload.arrayBuffer()));
        if (crop.isEmpty() || crop.getSize().width !== 1024 || crop.getSize().height !== 1024 || maskImage.isEmpty() || maskImage.getSize().width !== 1024 || maskImage.getSize().height !== 1024 || init.body.get('background') !== 'opaque') throw new Error('Speech generation uploaded the wrong template or mask geometry.');
        const mask = maskImage.toBitmap(), pixels = crop.toBitmap();
        let editable = 0;
        for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
          const index = (y * 1024 + x) * 4;
          const column = Math.min(2, Math.floor(x * 3 / 1024)), row = Math.min(2, Math.floor(y * 3 / 1024)), cell = row * 3 + column;
          if (cell === 8 && mask[index + 3] !== 255) throw new Error('Rest cell was not protected by the edit mask.');
          if (mask[index + 3] !== 0) continue;
          editable++;
          if (!pixels[index + 3]) continue;
          const localX = (x - Math.floor(column * 1024 / 3)) / 341;
          const localY = (y - Math.floor(row * 1024 / 3)) / 341;
          const mouth = ((localX - .5) / (.07 + cell * .006)) ** 2 + ((localY - .5) / (.025 + cell * .008)) ** 2 < 1;
          for (let channel = 0; channel < 3; channel++) pixels[index + channel] = mouth ? 20 + cell * 2 : Math.min(pixels[index + 3], pixels[index + channel] + 8 + cell);
        }
        if (!editable) throw new Error('Speech edit mask had no editable pixels.');
        encoded = nativeImage.createFromBitmap(pixels, { width: 1024, height: 1024 }).toPNG().toString('base64');
        fixtureRequests.mouthCropUploads++; fixtureRequests.mouthAtlases++;
      } else {
        fixtureRequests.walkAtlases++;
        if (failWalkingAfter !== undefined) {
          if (failWalkingAfter-- === 0) { failWalkingAfter = undefined; return new Response(null, { status: 503 }); }
        }
        if (holdNextWalking) {
          holdNextWalking = false;
          await new Promise<never>((_, reject) => {
            if (init.signal?.aborted) reject(new DOMException('Fixture cancelled.', 'AbortError'));
            else init.signal?.addEventListener('abort', () => reject(new DOMException('Fixture cancelled.', 'AbortError')), { once: true });
          });
        }
        encoded = fixtureAtlas(2, /walking-out/i.test(prompt) ? 3 : 1);
      }
    } else throw new Error('Unexpected character fixture endpoint.');
    return Response.json({ data: [{ b64_json: encoded }] });
  };
}

/** Exercises real UI, preload, IPC, image staging and persistence without paid API requests. */
export async function runCharacterCreationSmoke(window: BrowserWindow, outputDir: string): Promise<Record<string, unknown>> {
  if (!process.argv.includes('--smoke-test') || !process.argv.includes('--character-suite-check') ||
    path.relative(path.join(process.cwd(), '.qa', 'profile'), app.getPath('userData')) !== '') {
    throw new Error('Character creation checks require smoke flags and the isolated .qa/profile test profile.');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const bounded = async <T>(operation: Promise<T>, label: string, ms = 15000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), ms); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const evaluate = <T = unknown>(source: string) => bounded(window.webContents.executeJavaScript(source, true) as Promise<T>, 'Character UI script');
  const waitFor = async (expression: string, description: string, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(description);
  };
  const click = (selector: string) => evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});element.click()})()`);
  const setValue = (selector: string, value: string, select = false) => evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element||element.disabled)throw new Error('Field unavailable: '+${JSON.stringify(selector)});const prototype=element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:element.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,${JSON.stringify(value)});element.dispatchEvent(new Event(${JSON.stringify(select ? 'change' : 'input')},{bubbles:true}));${select ? '' : "element.dispatchEvent(new Event('change',{bubbles:true}));"}})()`);
  const reload = async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Character smoke reload timed out.')); }, 15000);
      const loaded = () => { cleanup(); resolve(); };
      const discard = (event: Electron.Event) => event.preventDefault();
      const cleanup = () => { clearTimeout(timeout); window.webContents.removeListener('did-finish-load', loaded); window.webContents.removeListener('will-prevent-unload', discard); };
      window.webContents.once('did-finish-load', loaded); window.webContents.once('will-prevent-unload', discard);
      window.webContents.reload();
    });
    await waitFor(`document.querySelector('[data-ready]')`, 'Character studio did not restore.');
  };
  const screenshot = async (name: string, selector?: string) => {
    await evaluate(`(async()=>{await document.fonts.ready;const visible=[...document.images].filter(image=>{const r=image.getBoundingClientRect();return r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth});await Promise.race([Promise.all(visible.map(image=>image.decode().catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,1500))]);await Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,500))])})()`);
    await new Promise(resolve => setTimeout(resolve, 200));
    const rect = selector ? await evaluate<{ x: number; y: number; width: number; height: number }>(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}})()`) : undefined;
    const filename = path.join(outputDir, name);
    // Offscreen Chromium can briefly lack a compositor surface after a resize.
    for (let attempt = 0; ; attempt++) {
      try { await fs.writeFile(filename, (await bounded(window.webContents.capturePage(rect), 'Character screenshot', 5000)).toPNG()); return filename; }
      catch (error) {
        if (attempt >= 2 || (!String(error).includes('UnknownVizError') && !String(error).includes('Character screenshot timed out'))) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  };
  const save = async () => {
    await click('.save-button');
    await waitFor(`document.querySelector('.save-state')?.textContent==='All changes saved'`, 'Generated character did not save.');
  };
  const active = () => evaluate<Character>('window.vox.bootstrap().then(data=>data.characters.find(character=>character.id===data.settings.activeCharacterId))');
  const assertSuite = (character: Character) => {
    if (character.animationMode !== 'viseme' || VISEMES.some(pose => character.visemes?.[pose]?.length !== 1) ||
      character.closed.length !== 1 || character.open.length !== 1 || character.motions?.enter?.frames.length !== 4 || character.motions?.exit?.frames.length !== 4 ||
      characterSprites(character).length !== 19 || new Set(characterSprites(character).map(sprite => sprite.id)).size !== 19) {
      throw new Error('Generated suite did not preserve nineteen distinct sprite mappings.');
    }
    if (character.motions.enter.side !== 'right' || character.motions.exit.side !== 'right') throw new Error('Default walking clips did not share the selected right edge.');
  };
  const proveMouthPreservation = async (character: Character, selectedRegion = fixtureMouthRegion) => {
    const original = nativeImage.createFromBuffer(Buffer.from(fixtureAtlas(1, 0), 'base64'));
    const size = original.getSize(); const originalPixels = original.toBitmap();
    const region = regionToPixels(selectedRegion, size.width, size.height, .65);
    const data = await evaluate<{ overlayOrigin: string; token: string }>('window.vox.bootstrap().then(({overlayOrigin,token})=>({overlayOrigin,token}))');
    for (const pose of VISEMES) {
      const sprite = character.visemes?.[pose]?.[0];
      if (!sprite) throw new Error(`Mouth preservation proof is missing pose ${pose}.`);
      const response = await fetch(`${data.overlayOrigin}/assets/${encodeURIComponent(character.id)}/${encodeURIComponent(sprite.file)}?token=${data.token}`);
      if (!response.ok) throw new Error(`Mouth preservation proof could not fetch pose ${pose}.`);
      const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
      if (image.isEmpty() || image.getSize().width !== size.width || image.getSize().height !== size.height) throw new Error(`Mouth pose ${pose} changed the original canvas size.`);
      const pixels = image.toBitmap();
      if (pose === 'X' && !pixels.equals(originalPixels)) throw new Error('Rest pose X did not preserve the exact original character.');
      for (let y = 0; y < size.height; y++) {
        const row = y * size.width * 4;
        const insideRows = y >= region.y && y < region.y + region.height;
        const left = row + (insideRows ? region.x : size.width) * 4;
        const right = row + (region.x + region.width) * 4;
        if (!pixels.subarray(row, left).equals(originalPixels.subarray(row, left)) ||
          (insideRows && !pixels.subarray(right, row + size.width * 4).equals(originalPixels.subarray(right, row + size.width * 4)))) {
          throw new Error(`Mouth pose ${pose} changed protected artwork outside the selected mouth area.`);
        }
      }
    }
    return { ok: true, poses: 9, outsideSelectedPixelsIdentical: true, restIsExactOriginal: true, originalWidth: size.width, originalHeight: size.height, selectedRegion };
  };
  const assertCreatorMotionDefaults = async () => {
    const defaults = await evaluate<{ entrance: string; sameEdge: boolean; independentExit: boolean; entranceEffects: string[]; exitEffects: string[]; selected: string[] }>(`({entrance:document.querySelector('#creator-entrance-side')?.value,sameEdge:!!document.querySelector('.same-edge input')?.checked,independentExit:!!document.querySelector('#creator-exit-side'),entranceEffects:[...document.querySelectorAll('input[id^="creator-motion-enter-"]')].map(input=>input.id.slice('creator-motion-enter-'.length)),exitEffects:[...document.querySelectorAll('input[id^="creator-motion-exit-"]')].map(input=>input.id.slice('creator-motion-exit-'.length)),selected:[...document.querySelectorAll('.motion-selection input:checked')].map(input=>input.id)})`);
    if (defaults.entrance !== 'right' || !defaults.sameEdge || defaults.independentExit || !['walk', 'smoke', 'fall-jump'].every(effect => defaults.entranceEffects.includes(effect) && defaults.exitEffects.includes(effect))) {
      throw new Error('Creator did not default to the same right edge or expose all entrance and exit effects.');
    }
    if (defaults.selected.join(',') !== 'creator-motion-enter-walk,creator-motion-exit-walk') throw new Error('Creator did not default to one walk in each direction.');
    await click('.same-edge input');
    await waitFor(`document.querySelector('#creator-exit-side')`, 'Independent exit direction did not become selectable.');
    await setValue('#creator-exit-side', 'left', true);
    if (await evaluate<string>(`document.querySelector('#creator-exit-side').value`) !== 'left') throw new Error('Independent exit direction did not update.');
    await click('.same-edge input');
    await waitFor(`!document.querySelector('#creator-exit-side') && document.querySelector('.same-edge input')?.checked`, 'Same-edge walking selection did not restore.');
    return { ok: true, defaultEntrance: 'right', defaultExit: 'right', sameEdge: true, independentExitSelectable: true, effects: defaults.entranceEffects };
  };
  const selectManualMouthRegion = async () => {
    await click('.mouth-region .segmented button:nth-child(2)');
    await waitFor(`document.querySelectorAll('.region-fields input').length===4`, 'Manual mouth selection fields did not appear.');
    for (const [index, value] of ['40', '27', '20', '8'].entries()) await setValue(`.region-fields label:nth-child(${index + 1}) input`, value);
    const selected = await evaluate<string[]>(`[...document.querySelectorAll('.region-fields input')].map(input=>input.value)`);
    if (selected.join(',') !== '40,27,20,8') throw new Error('Manual mouth selection did not retain the chosen percentages.');
  };
  const bounds = window.getBounds();
  const originalSettings = await evaluate<AppSettings>('window.vox.bootstrap().then(data=>data.settings)');
  if (await evaluate<boolean>(`document.querySelector('.save-state')?.textContent==='Unsaved changes'`)) {
    throw new Error('Character creation smoke requires a saved starting state; existing unsaved work was preserved.');
  }
  const result: Record<string, unknown> = { ok: true, fixtureApi: true, paidRequests: 0, physicalAudioUsed: false };
  try {
    if (await evaluate<boolean>(`document.querySelector('.transport')?.textContent.includes('Stop audio')`)) await click('.transport');
    await evaluate(`window.vox.saveSettings({...${JSON.stringify(originalSettings)},mode:'direct'})`); await reload();
    await click('.add-character');
    await waitFor(`document.querySelector('.character-creator')`, 'Character creator did not open.');
    await waitFor(`document.querySelector('.creator-tabs button:first-child')?.getAttribute('aria-pressed')==='true'`, 'Image input was not the primary creator route.');
    result.imageFirst = true;
    result.creationMotionControls = await assertCreatorMotionDefaults();
    await click('.creator-tabs button:nth-child(2)');
    await setValue('#creator-name', 'Fixture idea suite');
    await setValue('#creator-description', 'A friendly green robot with an expressive face and walking legs.');
    await setValue('#creator-style', 'Keep transparent padding and consistent proportions.');
    await click('#creator-motion-enter-walk');
    if (!await evaluate<boolean>(`document.querySelector('#generate-character').disabled`)) throw new Error('Creation allowed no entrance animation.');
    await click('#creator-motion-enter-walk');
    for (const kind of ['enter', 'exit']) for (const effect of ['fall-jump', 'smoke']) await click(`#creator-motion-${kind}-${effect}`);
    await waitFor(`!document.querySelector('#generate-character')?.disabled`, 'Optional character generation was unavailable.');
    window.setSize(1440, 960); await evaluate('window.scrollTo(0,0)');
    result.creatorDesktop = await screenshot('character-creator-desktop.png');
    window.setSize(1120, 740);
    result.creatorMinimum = await screenshot('character-creator-minimum.png');
    await evaluate(`document.querySelector('.creator-motion').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.creatorMotionMinimum = await screenshot('character-creator-animations-minimum.png');
    await evaluate('window.scrollTo(0,0)');
    result.creatorLayout = await evaluate(`({width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,nameLabeled:!!document.querySelector('label[for="creator-name"]'),descriptionLabeled:!!document.querySelector('label[for="creator-description"]'),generateAvailable:!document.querySelector('#generate-character').disabled})`);
    if ((result.creatorLayout as { overflow: boolean }).overflow) throw new Error('Character creator overflowed the minimum window width.');
    await click('#generate-character');
    await waitFor(`document.querySelectorAll('.pose-status button.complete').length===9 && document.querySelector('.walk-preview')`, 'Generated kit did not open with all nine poses and walking controls.');
    await waitFor(`document.querySelector('.avatar-canvas img')?.complete && document.querySelector('.avatar-canvas img')?.naturalWidth>0`, 'Generated character artwork did not finish decoding.');
    window.setSize(1440, 960); await evaluate('window.scrollTo(0,0)');
    result.generatedStage = await screenshot('character-generated-stage.png', '.stage');
    const hashes = new Set<string>(); const poseScreenshots: Record<string, string> = {};
    for (const pose of VISEMES) {
      await setValue('#mouth-pose', pose, true);
      await waitFor(`document.querySelector('.avatar-canvas img')?.alt.includes(${JSON.stringify(`${pose} mouth pose`)}) && document.querySelector('.avatar-canvas img')?.src===document.querySelector('.frame-select img')?.src && document.querySelector('.avatar-canvas img')?.complete && document.querySelector('.avatar-canvas img')?.naturalWidth>0`, `Generated mouth pose ${pose} did not decode.`);
      const address = await evaluate<string>(`document.querySelector('.avatar-canvas img').src`);
      const url = new URL(address);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/assets/')) throw new Error('Generated pose was not a managed local asset.');
      const response = await fetch(url); if (!response.ok) throw new Error('Generated pose asset was unavailable.');
      const png = Buffer.from(await response.arrayBuffer());
      const image = nativeImage.createFromBuffer(png);
      if (image.isEmpty() || image.toBitmap()[3] !== 0) throw new Error(`Generated mouth pose ${pose} lost its transparent corner.`);
      hashes.add(createHash('sha256').update(png).digest('hex'));
      await evaluate('window.scrollTo(0,0)');
      poseScreenshots[pose] = await screenshot(`character-mouth-${pose}.png`, '.stage');
    }
    if (hashes.size !== 9) throw new Error('Generated mouth poses did not contain nine distinct decoded images.');
    result.mouthAudition = { ok: true, distinctDecodedImages: hashes.size, transparentCorners: true, screenshots: poseScreenshots };
    await click('.walk-preview button:nth-of-type(2)');
    await waitFor(`document.querySelector('.avatar-canvas')?.style.visibility==='hidden'`, 'Walking out did not hide the character.', 5000);
    result.walkOut = await screenshot('character-walked-out.png', '.stage');
    await click('.walk-preview button:nth-of-type(1)');
    await waitFor(`document.querySelector('.avatar-canvas')?.style.visibility==='visible' && document.querySelector('.avatar-canvas img')?.style.transform.includes('translate(')`, 'Walking in did not begin.');
    await new Promise(resolve => setTimeout(resolve, 2000));
    await waitFor(`document.querySelector('.avatar-canvas')?.style.visibility==='visible' && document.querySelector('.avatar-canvas img')?.style.transform.includes('translate(0px, 0px)')`, 'Walking in did not return the character to its anchor.', 5000);
    result.walkingPreview = { ok: true, exitHides: true, entranceReturns: true, durationMs: 1800, screenshot: await screenshot('character-walked-in.png', '.stage') };
    await evaluate(`document.querySelector('.builder').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.generatedBuilder = await screenshot('character-generated-builder.png');
    await save(); const generated = await active(); assertSuite(generated);
    result.generatedMouthPreservation = await proveMouthPreservation(generated);
    await reload();
    const restored = await active(); assertSuite(restored);
    if (JSON.stringify(restored) !== JSON.stringify(generated)) throw new Error('Generated character changed during saved reload.');
    result.persistence = { ok: true, images: 19, visemes: 9, walkingClips: 2, framesPerWalkingClip: 4 };
    for (const kind of ['enter', 'exit'] as const) for (const effect of ['walk', 'fall-jump', 'smoke'] as const) {
      if (!hasMotion(restored, kind, effect)) throw new Error('Multi-selection creation lost a selected animation.');
    }
    result.multipleAnimationCreation = { ok: true, entranceTypes: 3, exitTypes: 3, savedAndRestored: true };
    const exited = await evaluate<{ visible: boolean; sequence: number }>(`window.vox.setCharacterPresence(${JSON.stringify(generated.id)},false)`);
    const entered = await evaluate<{ visible: boolean; sequence: number }>(`window.vox.setCharacterPresence(${JSON.stringify(generated.id)},true)`);
    if (exited.visible || !entered.visible || entered.sequence <= exited.sequence) throw new Error('Real OBS presence IPC did not acknowledge ordered exit and entrance commands.');
    result.obsPresenceIpc = { ok: true, orderedCommands: true };
    await click('.add-character');
    await waitFor(`document.querySelector('.reference-picker')`, 'Image-based creator did not open.');
    await click('.reference-picker');
    await waitFor(`document.querySelector('.reference-picker.has-reference img')?.complete && document.querySelector('.reference-picker.has-reference img')?.naturalWidth>0`, 'Fixture reference chooser did not expose a decoded primary input.');
    await setValue('#creator-name', 'Fixture image suite');
    if (!await evaluate<boolean>(`document.querySelector('#generate-character').disabled`)) throw new Error('Image generation did not require a reviewed speech area.');
    await click('.mouth-region .segmented button:first-child');
    await waitFor(`document.querySelector('.face-outline') && document.querySelector('.mouth-outline') && !document.querySelector('#generate-character').disabled`, 'Face detection did not expose both selections for review.');
    await evaluate(`document.querySelector('.mouth-region').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.faceDetectionReview = { ok: true, generateRequiresSelection: true, faceAndMouthVisible: true, screenshot: await screenshot('character-face-detection-review.png') };
    await selectManualMouthRegion();
    await waitFor(`!document.querySelector('#generate-character')?.disabled`, 'Image-based character generation was unavailable.');
    window.setSize(1440, 960); await waitFor('innerWidth>1400', 'Desktop creator resize did not settle.');
    await evaluate(`document.querySelector('.mouth-region').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.manualMouthEditor = await screenshot('character-mouth-region-editor.png');
    window.setSize(1440, 960); await evaluate('window.scrollTo(0,0)');
    result.sourceImageCreator = await screenshot('character-source-image-creator.png');
    window.setSize(1120, 740); await evaluate('window.scrollTo(0,0)');
    result.sourceImageCreatorMinimum = await screenshot('character-source-image-creator-minimum.png');
    if (await evaluate<boolean>('document.documentElement.scrollWidth>innerWidth')) throw new Error('Image-based creator overflowed the minimum window width.');
    await waitFor('innerWidth<1140', 'Minimum creator resize did not settle.');
    await evaluate(`document.querySelector('.mouth-region').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.manualMouthEditorMinimum = await screenshot('character-mouth-region-minimum.png');
    result.manualMouthLayout = await evaluate(`({inputs:document.querySelectorAll('.region-fields input').length,overflow:document.documentElement.scrollWidth>innerWidth,fieldsVisible:[...document.querySelectorAll('.region-fields input')].every(input=>{const r=input.getBoundingClientRect();return r.top>=72&&r.bottom<=innerHeight})})`);
    if (!(result.manualMouthLayout as { fieldsVisible: boolean }).fieldsVisible) throw new Error('Manual mouth region fields were not visible at the minimum window size.');
    window.setSize(1440, 960); await evaluate('window.scrollTo(0,0)');
    const mouthDetectionsBeforeManual = fixtureRequests.mouthDetections;
    await click('#generate-character');
    await waitFor(`document.querySelectorAll('.pose-status button.complete').length===9 && document.querySelector('.walk-preview')`, 'Source image did not produce a complete suite.');
    await save(); assertSuite(await active()); await reload(); const sourceCharacter = await active(); assertSuite(sourceCharacter);
    if (fixtureRequests.mouthDetections !== mouthDetectionsBeforeManual) throw new Error('Manual mouth selection still sent automatic mouth detection.');
    result.sourceImageMouthPreservation = await proveMouthPreservation(sourceCharacter);
    result.sourceImageRoute = { ok: true, nativeChooserFixture: true, manualMouthSelection: true, manualSelectionSkipsDetection: true, completeSuiteSavedAndRestored: true };
    const requestsBeforeLocalAddition = fixtureRequests.walkAtlases + fixtureRequests.mouthAtlases;
    const localAddition = await evaluate<Character>(`window.vox.generateCharacterMotions({character:${JSON.stringify(sourceCharacter)},animations:{enter:['smoke'],exit:['fall-jump']}})`);
    if (!hasMotion(localAddition, 'enter', 'smoke') || !hasMotion(localAddition, 'exit', 'fall-jump') ||
      requestsBeforeLocalAddition !== fixtureRequests.walkAtlases + fixtureRequests.mouthAtlases || JSON.stringify(await active()) !== JSON.stringify(sourceCharacter)) throw new Error('Adding only local effects requested images or changed the saved character.');
    result.localOnlyAddition = { ok: true, imageApiRequests: 0, activeWalkingClipsRetained: true, savedCharacterUnchanged: true };
    const localEffects: Record<string, unknown> = {};
    for (const effect of ['smoke', 'fall-jump'] as const) {
      const character: Character = { ...sourceCharacter, motions: {
        enter: { ...sourceCharacter.motions!.enter!, frames: [], effect, durationMs: 1800 },
        exit: { ...sourceCharacter.motions!.exit!, frames: [], effect, durationMs: 1800 }
      } };
      await evaluate(`window.vox.saveCharacter(${JSON.stringify(character)})`); await reload();
      await waitFor(`document.querySelector('.avatar-canvas img')?.complete && document.querySelector('.avatar-canvas img')?.naturalWidth>0`, `${effect} fallback artwork did not load.`);
      const transform = `(()=>{const t=document.querySelector('.avatar-canvas img')?.style.transform||'';const match=t.match(/translate\\(([-.\\d]+)px,\\s*([-.\\d]+)px\\)/);return match?{x:Number(match[1]),y:Number(match[2])}:{x:0,y:0}})()`;
      const smokeIsPainted = `(()=>{const canvas=document.querySelector('.avatar-smoke');if(!canvas?.width||!canvas?.height)return false;const data=canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data;return data[3]>0})()`;
      const partiallyVisible = `(()=>{const image=document.querySelector('.avatar-canvas img');const opacity=Number(image?.style.opacity||'1');return opacity>.15&&opacity<.85})()`;
      await click('.walk-preview button:nth-of-type(2)');
      if (effect === 'smoke') await waitFor(`${smokeIsPainted} && ${partiallyVisible}`, 'Smoke exit did not paint a puff while fading the original artwork.', 2500);
      else await waitFor(`(${transform}).y < -100`, 'Jump exit did not move the original artwork upward.', 2500);
      const exitScreenshot = await screenshot(`character-${effect}-exit.png`, '.stage');
      await waitFor(`document.querySelector('.avatar-canvas')?.style.visibility==='hidden'`, `${effect} exit did not hide the character.`, 5000);
      await click('.walk-preview button:nth-of-type(1)');
      if (effect === 'smoke') await waitFor(`${smokeIsPainted} && ${partiallyVisible}`, 'Smoke entrance did not paint a puff while revealing the original artwork.', 2500);
      else await waitFor(`(${transform}).y < -100 && document.querySelector('.avatar-canvas')?.style.visibility==='visible'`, 'Falling entrance did not start above the character anchor.', 2500);
      const entranceScreenshot = await screenshot(`character-${effect}-entrance.png`, '.stage');
      await waitFor(`document.querySelector('.avatar-canvas')?.style.visibility==='visible' && (${transform}).x===0 && (${transform}).y===0 && Number(document.querySelector('.avatar-canvas img')?.style.opacity||'1')===1`, `${effect} entrance did not finish at the original anchor.`, 5000);
      localEffects[effect] = { ok: true, emptyFramesUseOriginalArtwork: true, exitHides: true, entranceReturns: true, entranceScreenshot, exitScreenshot };
    }
    result.localEffects = localEffects;
    await click('.add-character');
    await waitFor(`document.querySelector('.reference-picker')`, 'Local-effect image creator did not open.');
    await click('.reference-picker');
    await waitFor(`document.querySelector('.reference-picker.has-reference img')?.complete && document.querySelector('.reference-picker.has-reference img')?.naturalWidth>0`, 'Local-effect reference image did not load.');
    await setValue('#creator-name', 'Fixture local effects suite');
    await click('.mouth-region .segmented button:first-child');
    await waitFor(`document.querySelector('.face-outline') && document.querySelector('.mouth-outline') && !document.querySelector('#generate-character').disabled`, 'Local-effect face selection did not complete.');
    await setValue('#creator-speech-mode', 'face', true);
    await evaluate(`document.querySelector('.creator-speech').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.faceExpressionsCreator = await screenshot('character-face-expressions-creator.png');
    await click('#creator-motion-enter-walk'); await click('#creator-motion-exit-walk');
    await click('#creator-motion-enter-smoke'); await click('#creator-motion-exit-fall-jump');
    await waitFor(`!document.querySelector('#generate-character')?.disabled`, 'Local-effect character generation was unavailable.');
    const walkingRequestsBeforeLocalGeneration = fixtureRequests.walkAtlases;
    await click('#generate-character');
    await waitFor(`document.querySelectorAll('.pose-status button.complete').length===9 && document.querySelector('.walk-preview')`, 'Local-effect generation did not create all speech poses and presence controls.');
    await save(); const localGenerated = await active();
    await reload(); const localRestored = await active();
    if (JSON.stringify(localRestored) !== JSON.stringify(localGenerated)) throw new Error('Local-effect character changed during saved reload.');
    if (localRestored.animationMode !== 'viseme' || VISEMES.some(pose => localRestored.visemes?.[pose]?.length !== 1) ||
      localRestored.closed.length !== 1 || localRestored.open.length !== 1 || characterSprites(localRestored).length !== 11 ||
      new Set(characterSprites(localRestored).map(sprite => sprite.id)).size !== 11 ||
      localRestored.motions?.enter?.effect !== 'smoke' || localRestored.motions.enter.frames.length !== 0 || localRestored.motions.enter.durationMs !== 1000 ||
      localRestored.motions?.exit?.effect !== 'fall-jump' || localRestored.motions.exit.frames.length !== 0 || localRestored.motions.exit.durationMs !== 1000) {
      throw new Error('Local-effect generation did not retain eleven speech assets, zero motion frames and the selected effects.');
    }
    if (fixtureRequests.walkAtlases !== walkingRequestsBeforeLocalGeneration) throw new Error('Selecting only local effects still requested paid walking artwork.');
    result.localEffectCreation = { ok: true, entrance: 'smoke', exit: 'fall-jump', mouthImages: 11, motionFrames: 0, durationMs: 1000, savedAndRestored: true, walkingApiRequests: 0,
      naturalFaceExpressions: true, facePreservation: await proveMouthPreservation(localRestored, fixtureFaceRegion) };
    const assetsDir = path.join(app.getPath('userData'), 'characters', localRestored.id, 'assets');
    const originalFiles = (await fs.readdir(assetsDir)).sort().join(',');
    const mouthRequestsBeforeAdditions = fixtureRequests.mouthAtlases;
    const detectionRequestsBeforeAdditions = fixtureRequests.mouthDetections;
    const walkingRequestsBeforeStage = fixtureRequests.walkAtlases;
    const staged = await evaluate<Character>(`window.vox.generateCharacterMotions({character:${JSON.stringify(localRestored)},animations:{enter:['walk'],exit:[]}})`);
    if (!hasMotion(staged, 'enter', 'walk') || staged.motions?.enter?.effect !== 'smoke') throw new Error('Staged generation replaced the active entrance.');
    if (fixtureRequests.walkAtlases - walkingRequestsBeforeStage !== 1 || hasMotion(staged, 'exit', 'walk')) throw new Error('Generating one missing walk also generated the unselected direction.');
    if (JSON.stringify(await active()) !== JSON.stringify(localRestored)) throw new Error('Animation generation saved without review.');
    await evaluate(`window.vox.discardCharacterDraft(${JSON.stringify(localRestored.id)})`);
    if ((await fs.readdir(assetsDir)).sort().join(',') !== originalFiles) throw new Error('Discard left staged motion images or removed saved speech images.');
    result.discardedAddition = { ok: true, stagedWalkingFrames: 4, savedArtworkRetained: true, stagedImagesRemoved: true };
    const duplicate = await evaluate<string>(`window.vox.generateCharacterMotions({character:${JSON.stringify(localRestored)},animations:{enter:['smoke'],exit:[]}}).then(()=>'',error=>error.message)`);
    if (!duplicate.includes('already has')) throw new Error('Existing animation generation was not rejected before API work.');
    await click('.character-heading button');
    await waitFor(`document.querySelector('.add-animations')`, 'Saved character did not expose missing animation generation.');
    if (await evaluate<number>(`document.querySelectorAll('.add-animations .motion-choice.available').length`) !== 2) throw new Error('Existing local animations were not marked already available.');
    for (const [kind, effect] of [['enter', 'walk'], ['exit', 'walk'], ['enter', 'fall-jump'], ['exit', 'smoke']]) await click(`#add-motion-${kind}-${effect}`);
    window.setSize(1440, 960); await evaluate(`document.querySelector('.add-animations').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.missingAnimationsDesktop = await screenshot('character-missing-animations-desktop.png');
    window.setSize(1120, 740); await waitFor('innerWidth<1140', 'Missing-animation minimum resize did not settle.');
    await evaluate(`document.querySelector('.add-animations').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.missingAnimationsMinimum = await screenshot('character-missing-animations-minimum.png');
    if (await evaluate<boolean>('document.documentElement.scrollWidth>innerWidth')) throw new Error('Missing-animation controls overflowed the minimum window width.');
    failWalkingAfter = 1;
    await click('#generate-character-motions');
    await waitFor(`document.querySelector('.add-animations .inline-error[role="alert"]') && !document.querySelector('#generate-character-motions').disabled`, 'Failed additions did not restore retry controls.');
    if (JSON.stringify(await active()) !== JSON.stringify(localRestored) || (await fs.readdir(assetsDir)).sort().join(',') !== originalFiles) throw new Error('Failed additions changed saved artwork.');
    result.failedAddition = { ok: true, secondWalkingRequestFailed: true, savedArtworkRetained: true, noPartialImages: true };
    holdNextWalking = true;
    await click('#generate-character-motions');
    await waitFor(`document.querySelector('.add-animations')?.getAttribute('aria-busy')==='true' && document.querySelector('.add-animations .generation-progress strong')?.textContent==='Creating the walk-on animation'`, 'Cancellable animation generation did not begin.');
    await click('.add-animations .creator-actions .secondary');
    await waitFor(`document.querySelector('.add-animations .inline-error')?.textContent.includes('cancelled') && !document.querySelector('#generate-character-motions').disabled`, 'Animation cancellation did not restore generation controls.');
    if (JSON.stringify(await active()) !== JSON.stringify(localRestored) || (await fs.readdir(assetsDir)).sort().join(',') !== originalFiles) throw new Error('Cancelled additions changed saved artwork.');
    result.cancelledAddition = { ok: true, currentRequestAborted: true, savedArtworkRetained: true, noPartialImages: true };
    const walkingRequestsBeforeRetry = fixtureRequests.walkAtlases;
    await click('#generate-character-motions');
    await waitFor(`document.querySelectorAll('.add-animations .motion-choice.available').length===6`, 'New choices were not added to the saved character draft.');
    if (fixtureRequests.walkAtlases - walkingRequestsBeforeRetry !== 2 || fixtureRequests.mouthAtlases !== mouthRequestsBeforeAdditions || fixtureRequests.mouthDetections !== detectionRequestsBeforeAdditions) throw new Error('Missing-motion generation repeated speech or unselected walking requests.');
    if (JSON.stringify(await active()) !== JSON.stringify(localRestored)) throw new Error('New animation choices saved before review.');
    await save(); await reload(); const completedCharacter = await active();
    if (JSON.stringify(completedCharacter.closed) !== JSON.stringify(localRestored.closed) || JSON.stringify(completedCharacter.open) !== JSON.stringify(localRestored.open) ||
      JSON.stringify(completedCharacter.visemes) !== JSON.stringify(localRestored.visemes) || JSON.stringify(completedCharacter.motions) !== JSON.stringify(localRestored.motions)) throw new Error('Adding animations changed existing speech or active clips.');
    for (const kind of ['enter', 'exit'] as const) for (const effect of ['walk', 'fall-jump', 'smoke'] as const) if (!hasMotion(completedCharacter, kind, effect)) throw new Error('An added animation was lost after restart.');
    await click('.character-heading button');
    await waitFor(`document.querySelector('#motion-effect-enter')`, 'Active animation chooser did not open.');
    await setValue('#motion-effect-enter', 'walk', true); await setValue('#motion-effect-exit', 'walk', true);
    await save(); await reload(); const walkingCharacter = await active();
    if (walkingCharacter.motions?.enter?.frames.length !== 4 || walkingCharacter.motions?.exit?.frames.length !== 4 || !hasMotion(walkingCharacter, 'enter', 'smoke') || !hasMotion(walkingCharacter, 'exit', 'fall-jump')) throw new Error('Switching active animations lost stored artwork or local choices.');
    result.existingCharacterAdditions = { ok: true, missingChoicesAdded: 4, walkingRequests: 2, speechRequests: 0, onlyMissingChoicesSelectable: true, activeClipsRetainedUntilChanged: true, reviewBeforeSave: true, switchedAndRestored: true };
    result.fixtureRequests = { ...fixtureRequests };
  } catch (error) {
    result.ok = false; result.error = error instanceof Error ? error.stack : String(error);
    result.failureScreenshot = await screenshot('character-creation-failure.png').catch(String);
  } finally {
    await evaluate(`window.vox.saveSettings(${JSON.stringify(originalSettings)})`);
    window.setBounds(bounds); await reload();
  }
  return result;
}
