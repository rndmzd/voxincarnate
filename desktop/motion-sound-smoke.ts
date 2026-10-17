import { app, BrowserWindow, dialog } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { overlayUrl, type Bootstrap } from './shared';
import type { LibraryStore } from './library';
import type { OverlayServer } from './overlay';
import { defaultMotion } from './character-motions';

/** Production renderer, preload, IPC, real WAV decoding and signal checks, isolated from user data. */
export async function runMotionSoundSmoke(window: BrowserWindow, store: LibraryStore, overlay: OverlayServer, origin: string, output: string) {
  assert(process.argv.includes('--smoke-test') && process.argv.includes('--motion-sound-check'));
  assert.equal(path.relative(path.join(process.cwd(), '.qa', 'motion-sound-profile'), app.getPath('userData')), '');
  const originalDialog = dialog.showOpenDialog;
  let source: BrowserWindow | undefined;
  const evaluate = async <T = any>(script: string, target = window): Promise<T> => {
    const result = await target.webContents.executeJavaScript(`(async()=>{try{return {value:await (${script})}}catch(error){return {error:String(error?.stack||error)}}})()`, true);
    if (result.error) throw new Error(`${result.error}\nScript: ${script.slice(0, 500)}`);
    return result.value;
  };
  const waitFor = async (expression: string, target = window) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(`Boolean(${expression})`, target)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Sound smoke timed out: ${expression}`);
  };
  const click = async (selector: string) => {
    await waitFor(`document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`);
    await evaluate(`(()=>{document.querySelector(${JSON.stringify(selector)}).click()})()`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`);
  };
  const select = async (selector: string, value: string) => {
    const ready = `document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`;
    await waitFor(ready);
    await evaluate(`(()=>{const item=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(item,${JSON.stringify(value)});item.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await evaluate(`new Promise(resolve=>requestAnimationFrame(resolve))`); await waitFor(ready);
  };
  const snapshot = () => evaluate<Bootstrap>('window.vox.bootstrap()');
  const save = async () => { await click('.save-button'); await waitFor(`document.querySelector('.save-state')?.textContent==='All changes saved'`); };
  const reload = async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Sound smoke reload timed out')), 10000);
      window.webContents.once('did-finish-load', () => { clearTimeout(timeout); resolve(); }); window.webContents.reload();
    });
    await waitFor(`document.querySelector('[data-ready]')`);
  };
  const installProbe = (target: BrowserWindow) => evaluate(`(async()=>{
    const NativeAudio=window.Audio;const context=new AudioContext();await context.resume();
    window.__soundProbe={clips:[],context};
    window.Audio=function(src){
      const audio=new NativeAudio();audio.crossOrigin='anonymous';audio.src=src;
      const analyser=context.createAnalyser();analyser.fftSize=2048;
      context.createMediaElementSource(audio).connect(analyser);analyser.connect(context.destination);
      const clip={audio,peak:0,maxTime:0,plays:0};window.__soundProbe.clips.push(clip);
      const play=audio.play.bind(audio);audio.play=()=>{clip.plays++;return play()};
      const samples=new Float32Array(analyser.fftSize);const tick=setInterval(()=>{
        analyser.getFloatTimeDomainData(samples);clip.peak=Math.max(clip.peak,...samples.map(Math.abs));clip.maxTime=Math.max(clip.maxTime,audio.currentTime)
      },10);audio.addEventListener('ended',()=>clearInterval(tick),{once:true});
      return audio
    };
  })()`, target);
  const probeState = (target = window) => evaluate<Array<{ src: string; peak: number; maxTime: number; paused: boolean; duration: number; plays: number }>>(`window.__soundProbe.clips.map(clip=>({src:clip.audio.src,peak:clip.peak,maxTime:clip.maxTime,paused:clip.audio.paused,duration:clip.audio.duration,plays:clip.plays}))`, target);
  const audible = async (count: number, target = window) => { await waitFor(`window.__soundProbe.clips.length===${count}&&window.__soundProbe.clips.at(-1)?.peak>0.001&&window.__soundProbe.clips.at(-1)?.maxTime>0.02`, target); };
  const screenshot = async (name: string) => {
    await evaluate(`document.fonts.ready`); await new Promise(resolve => setTimeout(resolve, 120));
    const filename = path.join(output, name); await fs.writeFile(filename, (await window.webContents.capturePage()).toPNG()); return filename;
  };
  try {
    window.webContents.setAudioMuted(true);
    await waitFor(`document.querySelector('[data-ready]')`);
    await click('.character-heading button');
    await waitFor(`document.querySelector('#motion-effect-enter')`);
    for (const kind of ['enter', 'exit']) await select(`#motion-effect-${kind}`, 'smoke');
    await select('#motion-sound-smoke', 'puff_of_smoke');
    await waitFor(`document.querySelector('#motion-sound-smoke')?.selectedOptions[0]?.textContent==='Puff of smoke.wav'`);
    await select('#motion-sound-walk', 'footsteps');
    await waitFor(`document.querySelector('#motion-sound-walk')?.selectedOptions[0]?.textContent==='Footsteps.wav'`);
    const soundsDir = path.join(app.isPackaged ? process.resourcesPath : app.getAppPath(), 'sounds');
    const customFile = path.resolve(output, 'custom-sound-fixture.wav');
    assert.equal(path.dirname(customFile), path.resolve(output));
    await fs.copyFile(path.join(soundsDir, 'puff_of_smoke.wav'), customFile);
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [customFile] })) as typeof dialog.showOpenDialog;
    await select('#motion-sound-fall-jump', 'custom');
    await waitFor(`document.querySelector('#motion-sound-fall-jump')?.selectedOptions[0]?.textContent==='custom-sound-fixture.wav'`);
    dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
    await select('#motion-sound-fall-jump', 'custom');
    await waitFor(`!document.querySelector('#motion-sound-fall-jump')?.disabled`);
    assert.equal(await evaluate(`document.querySelector('#motion-sound-fall-jump').selectedOptions[0].textContent`), 'custom-sound-fixture.wav');
    await save(); let saved = await snapshot(); let character = saved.characters.find(item => item.id === saved.settings.activeCharacterId)!;
    assert.deepEqual(Object.keys(character.motionSounds!).sort(), ['fall-jump', 'smoke', 'walk']);
    const restingBytes = await fs.readFile(store.assetPath(character.id, character.closed[0].file)!);
    const gait = await store.importImageBuffers(character.id, [{ name: 'On-air walk on fixture.png', png: restingBytes }, { name: 'On-air walk off fixture.png', png: restingBytes }]);
    character = { ...character, motionVariants: {
      enter: { walk: { ...defaultMotion('walk'), frames: [gait[0]], durationMs: 1000 } },
      exit: { walk: { ...defaultMotion('walk'), frames: [gait[1]], durationMs: 1000 } }
    } };
    await store.saveCharacter(character); overlay.refresh(); saved = await snapshot();
    await fs.unlink(customFile); await reload();
    await click('.character-heading button'); await waitFor(`document.querySelector('#motion-sound-smoke')`);
    assert.equal(await evaluate(`document.querySelector('#motion-sound-smoke').selectedOptions[0].textContent`), 'Puff of smoke.wav');
    const availability = () => evaluate<Array<{ id: string; disabled: boolean }>>(`[...document.querySelectorAll('.obs-presence button')].map(button=>({id:button.id,disabled:button.disabled}))`);
    const twoTypes = await availability();
    assert.equal(twoTypes.length, 6);
    assert.equal(twoTypes.filter(button => !button.disabled).length, 4);
    assert.ok(twoTypes.filter(button => button.id.includes('fall-jump')).every(button => button.disabled));
    assert.ok(twoTypes.filter(button => !button.id.includes('fall-jump')).every(button => !button.disabled));
    await installProbe(window);
    await click('[aria-label="Listen to walking sound"]'); await audible(1);
    assert.ok((await probeState()).at(-1)!.src.includes(character.motionSounds!.walk!.file));
    await click('[aria-label="Stop walking sound"]');
    await click('[aria-label="Listen to fall / jump sound"]'); await audible(2);
    assert.ok((await probeState()).at(-1)!.src.includes(character.motionSounds!['fall-jump']!.file));
    await click('[aria-label="Stop fall / jump sound"]');
    await click('[aria-label="Listen to smoke sound"]'); await audible(3);
    await click('[aria-label="Stop smoke sound"]'); await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`);
    await click('.walk-preview button:first-of-type'); await audible(4);
    const entrance = (await probeState()).at(-1)!; assert.ok(entrance.src.includes(character.motionSounds!.smoke!.file));
    await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`);
    await click('.walk-preview button:nth-of-type(2)'); await audible(5);
    const exit = (await probeState()).at(-1)!; assert.equal(exit.src, entrance.src);
    await click('.walk-preview button:first-of-type'); await audible(6);
    const studio = await probeState(); assert.equal(studio.at(-2)!.paused, true); assert.equal(studio.at(-1)!.plays, 1);
    await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`);

    source = new BrowserWindow({ show: false, width: 600, height: 600, transparent: true, backgroundColor: '#00000000',
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    source.webContents.setAudioMuted(true);
    await source.loadURL(overlayUrl({ ...saved, overlayOrigin: origin }, character.id));
    await waitFor(`connected&&document.images.length>0`, source); await installProbe(source);
    const localCount = studio.length;
    await click('#on-air-exit-smoke');
    await audible(1, source); await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`, source);
    await click('#on-air-enter-smoke');
    await audible(2, source); await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`, source);
    await click('#on-air-exit-walk');
    await waitFor(`state.presence?.effect==='walk' && !state.presence.visible && [...document.images].some(image=>image.src.includes(${JSON.stringify(gait[1].file)}) && getComputedStyle(image).display==='block')`, source);
    await audible(3, source); await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`, source);
    await click('#on-air-enter-walk');
    await waitFor(`state.presence?.effect==='walk' && state.presence.visible && [...document.images].some(image=>image.src.includes(${JSON.stringify(gait[0].file)}) && getComputedStyle(image).display==='block')`, source);
    await audible(4, source); await waitFor(`window.__soundProbe.clips.at(-1).audio.paused`, source);
    assert.equal((await probeState()).length, localCount, 'On-air commands must not double-play in the studio');
    const overlayAudio = await probeState(source); assert.equal(overlayAudio.length, 4); assert.equal(overlayAudio[0].src, overlayAudio[1].src);
    assert.equal(overlayAudio[2].src, overlayAudio[3].src);
    assert.ok(overlayAudio[0].src.includes(character.motionSounds!.smoke!.file));
    assert.ok(overlayAudio[2].src.includes(character.motionSounds!.walk!.file));
    assert.deepEqual((await snapshot()).characters.find(item => item.id === character.id), character, 'On-air triggers must preserve configured defaults and artwork');
    const sourceSequence = await evaluate<number>('state.presence.sequence', source);
    await evaluate(`(()=>{document.querySelector('#on-air-enter-fall-jump').click();document.querySelector('#on-air-exit-fall-jump').click()})()`);
    const unavailable = await evaluate<string>(`window.vox.setCharacterPresence(${JSON.stringify(character.id)},true,'fall-jump').then(()=>'',error=>error.message)`);
    assert.ok(unavailable.includes('does not have'));
    assert.equal(await evaluate<number>('state.presence.sequence', source), sourceSequence, 'Unavailable buttons and commands must not change live presence');
    for (const clip of overlayAudio) assert.ok(clip.peak > 0.001 && clip.maxTime > 0.02);
    overlay.refresh(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal((await probeState(source)).length, 4);
    await source.reload(); await waitFor(`connected&&document.images.length>0`, source); await installProbe(source);
    await new Promise(resolve => setTimeout(resolve, 120)); assert.equal((await probeState(source)).length, 0);

    await select('#motion-sound-smoke', 'none'); await save();
    await click('.walk-preview button:first-of-type'); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await probeState()).length, localCount);
    await select('#motion-sound-smoke', 'puff_of_smoke'); await waitFor(`!document.querySelector('#motion-sound-smoke').disabled`); await save();
    const screenshots: string[] = [];
    const layouts: unknown[] = [];
    for (const width of [1440, 1120]) {
      window.setSize(width, 960); await new Promise(resolve => setTimeout(resolve, 150));
      await evaluate(`document.querySelector('.animation-sounds').scrollIntoView({block:'center'})`);
      screenshots.push(await screenshot(`motion-sounds-${width}.png`));
      const layout = await evaluate(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,rows:[...document.querySelectorAll('.animation-sound-row')].map(row=>({row:row.getBoundingClientRect().width,select:row.querySelector('select').getBoundingClientRect().width,button:row.querySelector('button').getBoundingClientRect().width}))})`);
      assert.equal(layout.overflow, false); assert.ok(layout.rows.every((row: { select: number }) => row.select >= 200)); layouts.push(layout);
      await evaluate(`document.querySelector('.obs-presence').scrollIntoView({block:'center'})`);
      screenshots.push(await screenshot(`on-air-animations-${width}.png`));
      const controlsLayout = await evaluate(`({width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('.obs-presence button')].map(button=>({label:button.textContent,width:button.getBoundingClientRect().width,height:button.getBoundingClientRect().height}))})`);
      assert.equal(controlsLayout.overflow, false); assert.ok(controlsLayout.buttons.every((button: { width: number; height: number }) => button.width >= 80 && button.height >= 38)); layouts.push(controlsLayout);
    }
    const finalStudio = await probeState();
    await evaluate(`(()=>{const input=document.querySelector('.character-fields input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(`${character.name} draft`)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await waitFor(`document.querySelector('.save-state')?.textContent==='Unsaved changes'`);
    assert.ok((await availability()).every(button => button.disabled), 'Unsaved edits must disable all on-air choices');
    await evaluate(`(()=>{const input=document.querySelector('.character-fields input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(character.name)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`);
    await save();
    const finalCharacter = (await snapshot()).characters.find(item => item.id === character.id)!;
    const asymmetric = { ...finalCharacter, motions: { enter: defaultMotion('smoke'), exit: { ...defaultMotion('walk'), frames: [gait[1]] } }, motionVariants: {} };
    await store.saveCharacter(asymmetric); overlay.refresh(); await reload();
    assert.deepEqual((await availability()).filter(button => !button.disabled).map(button => button.id).sort(), ['on-air-enter-smoke', 'on-air-exit-walk']);
    await store.saveCharacter({ ...finalCharacter, motions: {}, motionVariants: {} }); overlay.refresh(); await reload();
    const noAnimations = await availability(); assert.equal(noAnimations.length, 6); assert.ok(noAnimations.every(button => button.disabled));
    await store.saveCharacter(finalCharacter); overlay.refresh(); await reload();
    return { ok: true, imports: 'two presets, custom WAV and cancelled file dialog', persistence: 'saved selections survive reload and removal of original custom fixture', studio: finalStudio, overlay: overlayAudio, onAirStudioAudioCount: localCount, noSound: true, noSnapshotReplay: true, screenshots, layouts,
      onAirAnimations: { ok: true, availableTypes: 2, enabledButtons: 4, unavailableButtons: 2, correctVariantArtwork: true, matchingSounds: true, defaultsPreserved: true, unsavedEditsDisableButtons: true, asymmetricChoices: true, emptyChoices: true, unavailableIpcRejected: true }, physicalObs: 'NOT RUN' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.stack : String(error), screenshot: await screenshot('motion-sounds-failure.png').catch(() => undefined) };
  } finally { dialog.showOpenDialog = originalDialog; source?.destroy(); }
}
