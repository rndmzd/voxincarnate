import { app, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Bootstrap, Character } from './shared';

/** Real renderer/preload/IPC checks; fixtures stay within the isolated smoke profile. */
export async function runCharacterDeletionSmoke(window: BrowserWindow, outputDir: string): Promise<Record<string, unknown>> {
  if (!process.argv.includes('--smoke-test') || !process.argv.includes('--character-delete-check') ||
    path.relative(path.join(process.cwd(), '.qa', 'character-delete-profile'), app.getPath('userData')) !== '') {
    throw new Error('Character deletion checks require both smoke flags and the isolated .qa/character-delete-profile test profile.');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const bounded = async <T>(operation: Promise<T>, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), 15000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const evaluate = <T = unknown>(source: string) => bounded(window.webContents.executeJavaScript(source, true) as Promise<T>, 'Deletion UI script');
  const waitFor = async (expression: string, description: string) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(`Boolean(${expression})`)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(description);
  };
  const click = (selector: string) => evaluate(`(()=>{const item=document.querySelector(${JSON.stringify(selector)});if(!item||item.disabled)throw new Error('Control unavailable: '+${JSON.stringify(selector)});item.click()})()`);
  const setValue = (selector: string, value: string, select = false) => evaluate(`(()=>{const item=document.querySelector(${JSON.stringify(selector)});if(!item||item.disabled)throw new Error('Field unavailable: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(item,${JSON.stringify(value)});item.dispatchEvent(new Event(${JSON.stringify(select ? 'change' : 'input')},{bubbles:true}));${select ? '' : "item.dispatchEvent(new Event('change',{bubbles:true}));"}})()`);
  const bootstrap = () => evaluate<Bootstrap>('window.vox.bootstrap()');
  const deletionButton = (name: string) => `.delete-character[aria-label=${JSON.stringify(`Delete ${name}`)}]`;
  const reload = async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('Deletion smoke reload timed out.')); }, 15000);
      const loaded = () => { cleanup(); resolve(); };
      const discard = (event: Electron.Event) => event.preventDefault();
      const cleanup = () => { clearTimeout(timer); window.webContents.removeListener('did-finish-load', loaded); window.webContents.removeListener('will-prevent-unload', discard); };
      window.webContents.once('did-finish-load', loaded); window.webContents.once('will-prevent-unload', discard);
      window.webContents.reload();
    });
    await waitFor(`document.querySelector('[data-ready]')`, 'Studio did not restore after deletion reload.');
  };
  const screenshot = async (name: string) => {
    await evaluate(`(async()=>{await document.fonts.ready;await Promise.race([Promise.all([...document.images].map(image=>image.decode().catch(()=>{}))),new Promise(resolve=>setTimeout(resolve,1500))]);await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`);
    const filename = path.join(outputDir, name);
    for (let attempt = 0; ; attempt++) {
      try { await fs.writeFile(filename, (await bounded(window.webContents.capturePage(), 'Deletion screenshot')).toPNG()); return filename; }
      catch (error) {
        if (attempt >= 2 || !String(error).includes('UnknownVizError')) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
    }
  };
  const setConfirmation = (accepted: boolean) => evaluate(`(()=>{window.__deleteConfirmations=[];window.confirm=message=>{window.__deleteConfirmations.push(String(message));return ${accepted}}})()`);
  const confirmations = () => evaluate<string[]>('window.__deleteConfirmations');
  const uiState = () => evaluate(`({
    draftName:document.querySelector('.character-fields input')?.value,
    dimensions:[...document.querySelectorAll('.character-fields input')].map(input=>input.value),
    gain:document.querySelector('#gain')?.value,sensitivity:document.querySelector('#sensitivity')?.value,hold:document.querySelector('#hold')?.value,
    pose:document.querySelector('#mouth-pose')?.value,selectedFrame:document.querySelector('.frame.selected .frame-select')?.textContent,
    alignment:[...document.querySelectorAll('.alignment input')].map(input=>input.value),
    editor:!!document.querySelector('.builder'),dirty:document.querySelector('.save-state')?.textContent,
    selected:document.querySelector('.character-item.selected strong')?.textContent,
    transport:document.querySelector('.transport')?.textContent,session:document.querySelector('.session-status')?.textContent,
    audioMode:document.querySelector('.mode-options .chosen')?.textContent
  })`);
  await waitFor(`document.querySelector('[data-ready]')`, 'Studio did not become ready for deletion checks.');
  if (await evaluate<boolean>(`document.querySelector('.save-state')?.textContent==='Unsaved changes'||document.querySelector('.transport')?.textContent.includes('Stop audio')`)) {
    throw new Error('Deletion smoke requires a saved, idle starting state; existing work was preserved.');
  }
  const original = await bootstrap();
  if (original.characters.length > 98) throw new Error('Deletion smoke needs room for two temporary characters.');
  const originalBounds = window.getBounds();
  const addedIds: string[] = [];
  const result: Record<string, unknown> = { ok: true, paidRequests: 0, physicalAudioUsed: false };
  const suffix = randomUUID().slice(0, 8);
  let active: Character | undefined;
  let inactive: Character | undefined;
  try {
    result.stage = 'create fixtures';
    for (const label of ['Active', 'Inactive']) {
      const created = await evaluate<Bootstrap>('window.vox.createVisemeDemo()');
      const character = created.characters.find(item => item.id === created.settings.activeCharacterId);
      if (!character || original.characters.some(item => item.id === character.id)) throw new Error('Temporary demo was not created independently.');
      addedIds.push(character.id);
      const renamed = { ...character, name: `${label} deletion check ${suffix}` };
      await evaluate(`window.vox.saveCharacter(${JSON.stringify(renamed)})`);
      if (label === 'Active') active = renamed; else inactive = renamed;
    }
    if (!active || !inactive) throw new Error('Deletion fixtures are missing.');
    await evaluate(`window.vox.saveSettings(${JSON.stringify({ ...original.settings, mode: 'direct', activeCharacterId: active.id })})`);
    await reload();
    result.stage = 'prepare unsaved edits';
    await click('.character-heading button');
    await waitFor(`document.querySelector('.builder')`, 'Character builder did not open for dirty-state verification.');
    await setValue('.character-fields input', `${active.name} unsaved`);
    const editedGain = original.settings.detector.gain === 1.7 ? '1.8' : '1.7';
    await setValue('#gain', editedGain);
    await setValue('#mouth-pose', 'F', true);
    await click('.frame-select');
    await setValue('.alignment input', '17');
    await waitFor(`document.querySelector('.save-state')?.textContent==='Unsaved changes'&&document.querySelector('.alignment input')?.value==='17'`, 'Unsaved character and settings changes did not apply.');
    const dirtyState = await uiState();
    const beforeCancel = await bootstrap();
    result.stage = 'cancel active deletion';
    await setConfirmation(false);
    await click(deletionButton(active.name));
    await waitFor(`!document.querySelector(${JSON.stringify(deletionButton(active.name))})?.disabled`, 'Cancelled deletion did not release its busy state.');
    const cancelledMessages = await confirmations();
    if (cancelledMessages.length !== 1 || JSON.stringify(await bootstrap()) !== JSON.stringify(beforeCancel) || JSON.stringify(await uiState()) !== JSON.stringify(dirtyState)) {
      throw new Error('Cancelling deletion changed the library, draft, editor or settings.');
    }
    result.cancellation = { ok: true, confirmationShown: true, unsavedWorkPreserved: true };
    window.setSize(1440, 960);
    await evaluate('window.scrollTo(0,0)');
    result.screenshot = await screenshot('deletion-ui.png');
    result.stage = 'delete inactive character';
    await setConfirmation(true);
    await click(deletionButton(inactive.name));
    await waitFor(`!document.querySelector(${JSON.stringify(deletionButton(inactive.name))})`, 'Inactive character did not disappear from the library.');
    const afterInactive = await bootstrap();
    if (afterInactive.characters.some(item => item.id === inactive!.id) || afterInactive.settings.activeCharacterId !== active.id ||
      JSON.stringify(afterInactive.settings) !== JSON.stringify(beforeCancel.settings) || JSON.stringify(await uiState()) !== JSON.stringify(dirtyState)) {
      throw new Error('Deleting an inactive character changed unsaved draft, settings, artwork selection or idle audio state.');
    }
    result.inactiveDeletion = { ok: true, unsavedCharacterPreserved: true, unsavedSettingsPreserved: true, editorAndArtworkSelectionPreserved: true, idleAudioStatePreserved: true };
    result.stage = 'delete active character';
    await setConfirmation(true);
    await click(deletionButton(active.name));
    await waitFor(`!document.querySelector(${JSON.stringify(deletionButton(active.name))})&&document.querySelector('.save-state')?.textContent==='All changes saved'&&!document.querySelector('.builder')`, 'Active deletion did not clear the draft/editor and select a saved character.');
    const activeMessages = await confirmations();
    if (activeMessages.length !== 1 || !/cannot be undone|permanent|irreversible/i.test(activeMessages[0]) || !/artwork|images/i.test(activeMessages[0]) || !/OBS/i.test(activeMessages[0])) {
      throw new Error('Deletion confirmation did not explain permanent artwork deletion and OBS impact.');
    }
    const afterActive = await bootstrap();
    const fallback = afterActive.characters.find(item => item.id === afterActive.settings.activeCharacterId);
    if (!fallback || addedIds.includes(fallback.id) || afterActive.characters.some(item => addedIds.includes(item.id))) throw new Error('Active deletion did not select a remaining saved character.');
    if (await evaluate<string>(`document.querySelector('.character-item.selected strong')?.textContent`) !== fallback.name ||
      await evaluate<string>(`document.querySelector('#gain')?.value`) !== String(afterActive.settings.detector.gain)) throw new Error('Active deletion left the deleted draft or unsaved settings visible.');
    result.activeDeletion = { ok: true, confirmationExplainsArtworkAndObs: true, selectsRemainingCharacter: true, unsavedStateCleared: true, builderClosed: true };
    result.stage = 'verify persistence';
    await reload();
    const restored = await bootstrap();
    if (restored.characters.some(item => addedIds.includes(item.id)) || restored.settings.activeCharacterId !== fallback.id ||
      await evaluate<number>('document.querySelectorAll(".character-row").length') !== original.characters.length) throw new Error('Character deletion did not persist after reload.');
    result.persistence = { ok: true, deletedCharactersAbsentAfterReload: true, selectionPreserved: true };
    result.stage = 'protect final character';
    if (restored.characters.length === 1) {
      const last = restored.characters[0];
      if (!await evaluate<boolean>(`document.querySelector(${JSON.stringify(deletionButton(last.name))})?.disabled`)) throw new Error('The final character deletion control is enabled.');
      const guard = await evaluate<{ rejected: boolean; message?: string }>(`window.vox.deleteCharacter(${JSON.stringify(last.id)}).then(()=>({rejected:false}),error=>({rejected:true,message:error.message}))`);
      if (!guard.rejected || JSON.stringify(await bootstrap()) !== JSON.stringify(restored)) throw new Error('Backend allowed the last character to be deleted.');
      result.lastCharacter = { ok: true, buttonDisabled: true, backendRejected: true };
    } else result.lastCharacter = { skipped: true, reason: 'The pre-existing smoke library has multiple characters; none were deleted for this check.' };
    result.stage = 'complete';
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.stack : String(error);
    result.failureScreenshot = await screenshot('deletion-ui-failure.png').catch(String);
  } finally {
    try {
      await evaluate(`window.vox.saveSettings(${JSON.stringify(original.settings)})`);
      const current = await bootstrap();
      for (const id of addedIds) if (current.characters.some(item => item.id === id)) await evaluate(`window.vox.deleteCharacter(${JSON.stringify(id)})`);
      window.setBounds(originalBounds);
      await reload();
      const cleaned = await bootstrap();
      if (JSON.stringify(cleaned.characters) !== JSON.stringify(original.characters) || JSON.stringify(cleaned.settings) !== JSON.stringify(original.settings)) throw new Error('Smoke cleanup did not restore the original library and settings.');
      result.cleanup = { ok: true, preexistingCharactersPreserved: true, settingsRestored: true, temporaryCharactersRemoved: true };
    } catch (error) { result.ok = false; result.cleanup = { ok: false, error: error instanceof Error ? error.stack : String(error) }; }
  }
  return result;
}
