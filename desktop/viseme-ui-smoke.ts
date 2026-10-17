import { app, type BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppSettings, Character } from './shared';
import { VISEMES } from './shared';

/** Exercises the shipped renderer through its real preload in the isolated smoke profile. */
export async function runVisemeUiSmoke(window: BrowserWindow, outputDir: string): Promise<Record<string, unknown>> {
  if (!process.argv.includes('--smoke-test') || path.relative(path.join(process.cwd(), '.qa', 'profile'), app.getPath('userData')) !== '') {
    throw new Error('Lip-sync UI checks require --smoke-test and the isolated .qa/profile test profile.');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const evaluate = <T = unknown>(source: string) => window.webContents.executeJavaScript(source, true) as Promise<T>;
  const waitFor = async (expression: string, description: string) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    throw new Error(description);
  };
  const click = (selector: string) => evaluate(`(()=>{const item=document.querySelector(${JSON.stringify(selector)});if(!item||item.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});item.click()})()`);
  const select = (selector: string, value: string) => evaluate(`(()=>{const item=document.querySelector(${JSON.stringify(selector)});if(!item||item.disabled)throw new Error('Picker unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(item,${JSON.stringify(value)});item.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  const reload = async () => {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Studio reload timed out.')); }, 15000);
      const loaded = () => { cleanup(); resolve(); };
      const unload = (event: Electron.Event) => event.preventDefault();
      const cleanup = () => { clearTimeout(timeout); window.webContents.removeListener('did-finish-load', loaded); window.webContents.removeListener('will-prevent-unload', unload); };
      window.webContents.once('did-finish-load', loaded);
      window.webContents.once('will-prevent-unload', unload);
      window.webContents.reload();
    });
    await waitFor(`document.querySelector('[data-ready]')`, 'Studio did not restore after reload.');
  };
  const openBuilder = async () => {
    if (!await evaluate<boolean>(`!!document.querySelector('.builder')`)) await click('.character-heading button');
    await waitFor(`document.querySelector('.builder')`, 'Character builder did not open.');
  };
  const screenshot = async (name: string, selector?: string) => {
    await evaluate(`(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
    const rectangle = selector ? await evaluate<{ x: number; y: number; width: number; height: number }>(`(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)}})()`) : undefined;
    const file = path.join(outputDir, name);
    for (let attempt = 0; ; attempt++) {
      try { await fs.writeFile(file, (await window.webContents.capturePage(rectangle)).toPNG()); return file; }
      catch (error) {
        if (attempt >= 2 || !String(error).includes('UnknownVizError')) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  };
  const save = async () => { await click('.save-button'); await waitFor(`document.querySelector('.save-state')?.textContent==='All changes saved'`, 'Character changes did not save.'); };
  const originalBounds = window.getBounds();
  const originalSettings = await evaluate<AppSettings>('window.vox.bootstrap().then(value=>value.settings)');
  const result: Record<string, unknown> = { ok: true, physicalAudioUsed: false };
  let demo: Character | undefined;
  try {
    if (await evaluate<boolean>(`document.querySelector('.transport')?.textContent.includes('Stop audio')`)) await click('.transport');
    await evaluate(`window.vox.saveSettings({...${JSON.stringify(originalSettings)},mode:'direct'})`);
    await reload();
    await click('.demo-character');
    await waitFor(`document.querySelectorAll('.pose-status button.complete').length===9`, 'Demo did not expose all nine mouth poses.');
    demo = await evaluate<Character>('window.vox.bootstrap().then(value=>value.characters.find(character=>character.id===value.settings.activeCharacterId))');
    if (demo.animationMode !== 'viseme' || VISEMES.some(pose => !demo?.visemes?.[pose]?.length)) throw new Error('The saved demo is missing lip-sync artwork.');
    const audition: Record<string, string> = {};
    for (const pose of VISEMES) {
      await select('#mouth-pose', pose);
      await evaluate('window.scrollTo(0,0)');
      const expectedFile = demo.visemes![pose]![0].file;
      await waitFor(`document.querySelector('.avatar-canvas img')?.getAttribute('src').includes(${JSON.stringify(encodeURIComponent(expectedFile))})`, `Pose ${pose} did not render its assigned artwork.`);
      audition[pose] = await screenshot(`viseme-${pose}.png`, '.stage');
    }
    result.audition = { ok: true, poses: audition, uniqueImages: new Set(VISEMES.map(pose => demo!.visemes![pose]![0].file)).size };
    await evaluate(`document.querySelector('.builder').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    window.setSize(1440, 960);
    result.desktopBuilder = await screenshot('viseme-builder-desktop.png');
    window.setSize(1120, 740);
    await evaluate(`document.querySelector('.builder').scrollIntoView({block:'start'});window.scrollBy(0,-88)`);
    result.minimumBuilder = await screenshot('viseme-builder-minimum.png');
    result.layout = await evaluate(`(()=>{const button=document.querySelector('.save-button').getBoundingClientRect();return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,saveVisible:button.top>=0&&button.bottom<=72,poseButtons:document.querySelectorAll('.pose-status button').length,labeledPosePicker:!!document.querySelector('label[for="mouth-pose"]'),labeledModePicker:!!document.querySelector('label[for="animation-mode"]')}})()`);
    const layout = result.layout as { overflow: boolean; saveVisible: boolean; poseButtons: number; labeledPosePicker: boolean; labeledModePicker: boolean };
    if (layout.overflow || !layout.saveVisible || layout.poseButtons !== 9 || !layout.labeledPosePicker || !layout.labeledModePicker) throw new Error(`Builder layout or accessible controls failed: ${JSON.stringify(layout)}`);
    await select('#animation-mode', 'binary'); await save(); await reload(); await openBuilder();
    await waitFor(`document.querySelector('#animation-mode')?.value==='binary'`, 'Binary mode did not survive a saved reload.');
    if (await evaluate<number>(`document.querySelectorAll('.pose-status button').length`)) throw new Error('Binary mode still shows lip-sync editing controls.');
    await select('#animation-mode', 'viseme'); await save(); await reload(); await openBuilder();
    await waitFor(`document.querySelectorAll('.pose-status button.complete').length===9`, 'Pose mappings did not survive mode changes and reload.');
    const reloaded = await evaluate<Character>('window.vox.bootstrap().then(value=>value.characters.find(character=>character.id===value.settings.activeCharacterId))');
    if (JSON.stringify(reloaded.visemes) !== JSON.stringify(demo.visemes)) throw new Error('Switching animation modes changed the pose artwork.');
    result.persistence = { ok: true, binaryAndVisemeModes: true, nineMappingsPreserved: true };
    await select('#mouth-pose', 'X');
    await waitFor(`document.querySelector('.pose-status button.active')?.textContent.startsWith('X')`, 'Rest pose did not become active for fallback validation.');
    await click('.frame-actions button:last-child');
    await waitFor(`document.querySelectorAll('.pose-status button.complete').length===8 && document.querySelector('.empty-frames')?.textContent.includes('fallback')`, 'Removing a pose did not expose fallback status.');
    await evaluate('window.scrollTo(0,0)');
    await waitFor(`document.querySelector('.avatar-canvas img')?.getAttribute('src').includes(${JSON.stringify(encodeURIComponent(demo.closed[0].file))})`, 'Missing rest pose did not render the closed-mouth fallback.');
    result.missingPose = { ok: true, screenshot: await screenshot('viseme-missing-pose.png', '.stage') };
    await save();
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.stack : String(error);
    result.failureScreenshot = await screenshot('viseme-ui-failure.png').catch(String);
  } finally {
    if (demo) await evaluate(`window.vox.saveCharacter(${JSON.stringify(demo)})`);
    await evaluate(`window.vox.saveSettings(${JSON.stringify(originalSettings)})`);
    window.setBounds(originalBounds);
    await reload();
  }
  return result;
}
