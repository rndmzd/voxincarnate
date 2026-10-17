import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, globalShortcut } from 'electron';
import type { Controls } from './controls';
import type { LibraryStore } from './library';
import type { OverlayServer } from './overlay';
import type { ControlCommand, ControlResponse } from './control-protocol';

export async function runControlsSmoke(studio: BrowserWindow, controls: Controls, store: LibraryStore, overlay: OverlayServer, output: string): Promise<Record<string, unknown>> {
  const report: Record<string, unknown> = { ok: true, physicalStreamDeck: 'NOT RUN', physicalMicrophone: 'NOT RUN' };
  const evaluate = async <T = unknown>(code: string): Promise<T> => {
    try { return await studio.webContents.executeJavaScript(code, true) as T; }
    catch (error) { throw new Error(`Studio check failed: ${code.slice(0, 180)}. ${(error as Error).message}`); }
  };
  const wait = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 18000;
    while (!await predicate()) { if (Date.now() > deadline) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 35)); }
  };
  const click = (selector: string) => evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw new Error('Button unavailable: '+${JSON.stringify(selector)});b.click()})()`);
  const input = (selector: string, value: string, select = false) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${select ? 'HTMLSelectElement' : 'HTMLInputElement'}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('${select ? 'change' : 'input'}',{bubbles:true}))})()`);
  const info = controls.info();
  const origin = `http://127.0.0.1:${info.settings.port}`;
  const headers = { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' };
  const command = async (value: ControlCommand, ok = true): Promise<ControlResponse> => {
    const response = await fetch(`${origin}/v1/commands`, { method: 'POST', headers, body: JSON.stringify(value) });
    const result = await response.json() as ControlResponse;
    if (ok && !result.ok) throw new Error(`${value.action}: ${result.message}`);
    return result;
  };
  const screenshot = async (name: string) => {
    await evaluate(`document.fonts.ready`); await new Promise(resolve => setTimeout(resolve, 80));
    await fs.writeFile(path.join(output, name), (await studio.webContents.capturePage()).toPNG());
  };
  let fixture: ReturnType<typeof createServer> | undefined;
  let inspector: BrowserWindow | undefined;
  try {
    await wait(() => controls.state().ready, 'Studio did not become ready.');
    assert.equal((await fetch(`${origin}/v1/status`)).status, 403);
    assert.equal((await fetch(`${origin}/v1/status`, { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    const status = await (await fetch(`${origin}/v1/status`, { headers })).text();
    assert(!status.includes(info.token)); assert(!status.includes(store.snapshot().token)); report.authentication = true;
    const refresh = await command({ action: 'inputs.refresh' }); assert(refresh.state.inputs.length > 0);
    await wait(() => evaluate<boolean>(`!document.querySelector('.save-button').disabled`), 'Refresh did not select a direct input.');
    await click('.save-button'); await wait(() => !controls.state().dirty && !controls.state().busy, 'Input selection was not saved.');
    assert.equal((await command({ action: 'audio.start' })).state.running, true);
    assert.equal((await command({ action: 'audio.start' })).state.running, true);
    assert.equal((await command({ action: 'inputs.refresh' }, false)).code, 'audio_running');
    assert.equal((await command({ action: 'audio.toggle' })).state.running, false); report.directCapture = true;

    const character = store.snapshot().characters[0];
    const clip = { frames: character.closed.map(sprite => ({ ...sprite, id: randomUUID() })), frameMs: 120, durationMs: 200, side: 'right' as const, effect: 'walk' as const };
    await store.saveCharacter({ ...character, motions: { enter: clip, exit: { ...clip, frames: clip.frames.map(sprite => ({ ...sprite, id: randomUUID() })) } }, motionVariants: {
      enter: { smoke: { ...clip, frames: [], effect: 'smoke' }, 'fall-jump': { ...clip, frames: [], effect: 'fall-jump' } },
      exit: { smoke: { ...clip, frames: [], effect: 'smoke' }, 'fall-jump': { ...clip, frames: [], effect: 'fall-jump' } }
    } });
    overlay.refresh(); studio.webContents.reload();
    await wait(() => controls.state().ready && controls.state().characters[0].motions.enter.length === 3, 'Motion setup did not load.');
    for (const effect of ['walk', 'smoke', 'fall-jump'] as const) {
      await command({ action: 'character.exit', characterId: character.id, effect }); assert.equal(overlay.getPresence(character.id).visible, false); assert.equal(overlay.getPresence(character.id).effect, effect);
      await command({ action: 'character.enter', characterId: character.id, effect }); assert.equal(overlay.getPresence(character.id).visible, true);
    }
    assert.equal(store.snapshot().characters[0].motions!.enter!.effect, 'walk'); report.sixOnAirAnimations = true;
    fixture = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Local assistant fixture</title><p>Control capture fixture</p><script>const ctx=new AudioContext();const tone=ctx.createOscillator();tone.frequency.value=220;const gain=ctx.createGain();gain.gain.value=.08;tone.connect(gain).connect(ctx.destination);tone.start();ctx.resume();</script>'); });
    fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
    const assistantUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    await store.saveSettings({ ...store.snapshot().settings, mode: 'browser', assistantUrl, browserInputId: '' });
    studio.webContents.reload(); await wait(() => controls.state().ready && controls.state().mode === 'browser', 'Browser mode did not load.');
    await new Promise(resolve => setTimeout(resolve, 450));
    const microphones = await command({ action: 'inputs.refresh' }); assert(microphones.state.inputs.length > 0);
    await input('#audio-input', microphones.state.inputs[0].deviceId, true);
    await wait(() => controls.state().dirty, 'Microphone selection did not become dirty.');
    assert.equal((await command({ action: 'audio.start' }, false)).code, 'unsaved_changes');
    assert.equal((await command({ action: 'character.exit' }, false)).code, 'unsaved_changes');
    await click('.save-button'); await wait(() => !controls.state().dirty && !controls.state().busy, 'Browser microphone was not saved.');
    studio.hide();
    const capture = await command({ action: 'audio.start' }); assert.equal(capture.state.running, true);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await evaluate<boolean>(`document.querySelector('.session-status').textContent.includes('Audio active')`), true);
    await command({ action: 'audio.stop' }); assert.equal(controls.state().running, false); report.backgroundAssistantCapture = true;

    await click('#open-control-settings'); await wait(() => evaluate<boolean>(`!!document.querySelector('#control-port')`), 'Control settings did not load.');
    await input('#hotkey-audio\\.start', 'Ctrl+Alt+Shift+F12');
    await click('.control-heading .primary');
    await wait(() => evaluate<boolean>(`document.querySelector('.control-notice')?.textContent.includes('saved')`), 'Hotkey settings were not saved.');
    assert(globalShortcut.isRegistered('Ctrl+Alt+Shift+F12')); assert(globalShortcut.isSuspended()); report.globalHotkeyRegistration = true;
    await input('#hotkey-audio\\.stop', 'Ctrl+Alt+Shift+F12');
    await click('.control-heading .primary');
    await wait(() => evaluate<boolean>(`document.querySelector('.control-heading [role=alert]')?.textContent.includes('different shortcut')`), 'Duplicate shortcut was not rejected.');
    studio.setContentSize(1120, 960);
    await evaluate(`document.querySelector('.control-dialog').scrollTop=document.querySelector('.control-dialog').scrollHeight`);
    await screenshot('controls-conflict-1120.png');
    assert(await evaluate<boolean>(`(()=>{const d=document.querySelector('.control-dialog').getBoundingClientRect(),a=document.querySelector('.control-heading [role=alert]').getBoundingClientRect();return a.top>=d.top&&a.bottom<d.bottom})()`));
    assert(globalShortcut.isRegistered('Ctrl+Alt+Shift+F12')); assert(globalShortcut.isSuspended());
    await input('#hotkey-audio\\.stop', 'Ctrl+Alt+Shift+F11'); await click('.control-heading .primary');
    await wait(() => evaluate<boolean>(`document.querySelector('.control-notice')?.textContent.includes('saved')`), 'Duplicate hotkey recovery failed.');
    report.duplicateHotkeyRecovery = true;
    for (const width of [1440, 1120]) {
      studio.setContentSize(width, 960); await new Promise(resolve => setTimeout(resolve, 100));
      await evaluate(`document.querySelector('.control-dialog').scrollTop=0`);
      await screenshot(`controls-${width}.png`);
      const layout = await evaluate<{ overflow: boolean; width: number }>(`(()=>{const d=document.querySelector('.control-dialog');return{overflow:d.scrollWidth>d.clientWidth+1,width:d.clientWidth}})()`);
      assert.equal(layout.overflow, false);
    }
    await evaluate(`const d=document.querySelector('.control-dialog');d.scrollTop=d.scrollHeight;`);
    await screenshot('controls-hotkeys-1120.png');
    assert(await evaluate<boolean>(`(()=>{const d=document.querySelector('.control-dialog').getBoundingClientRect(),b=document.querySelector('.control-heading .primary').getBoundingClientRect();return b.top>=d.top&&b.bottom<d.bottom})()`));
    await click('.control-heading .secondary'); await wait(() => !globalShortcut.isSuspended(), 'Hotkeys did not resume.'); report.settingsUi = true;
    const plugin = app.isPackaged ? path.join(process.resourcesPath, 'streamdeck/com.voxincarnate.streamdeck.streamDeckPlugin') : path.join(app.getAppPath(), 'build/streamdeck/com.voxincarnate.streamdeck.streamDeckPlugin');
    assert((await fs.stat(plugin)).size > 10000); report.pluginInstallerIncluded = true;
    inspector = new BrowserWindow({ width: 360, height: 650, show: false, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true } });
    await inspector.loadFile(path.join(app.getAppPath(), 'build/streamdeck/com.voxincarnate.streamdeck.sdPlugin/ui/settings.html'));
    const actionInfo = { action: 'com.voxincarnate.streamdeck.character.exit', payload: { settings: { characterId: character.id, effect: 'smoke' } } };
    await inspector.webContents.executeJavaScript(`window.fixtureSent=[];window.WebSocket=class{static OPEN=1;readyState=1;constructor(){window.fixtureSocket=this;setTimeout(()=>this.onopen?.(),0)}send(value){window.fixtureSent.push(JSON.parse(value))}};window.connectElgatoStreamDeckSocket('12345','inspector','registerPropertyInspector','{}',${JSON.stringify(JSON.stringify(actionInfo))});`);
    const inspectorStatus = { event: 'status', connected: true, message: 'Connected to Voxincarnate.', activeCharacterId: character.id, characters: controls.state().characters };
    await inspector.webContents.executeJavaScript(`window.fixtureSocket.onmessage({data:JSON.stringify({event:'sendToPropertyInspector',payload:${JSON.stringify(inspectorStatus)}})})`);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert(await inspector.webContents.executeJavaScript(`document.querySelector('#motion').hidden===false&&document.querySelector('#character').value===${JSON.stringify(character.id)}&&document.documentElement.scrollWidth<=innerWidth`));
    await fs.writeFile(path.join(output, 'streamdeck-inspector-connected.png'), (await inspector.webContents.capturePage()).toPNG());
    await inspector.webContents.executeJavaScript(`window.fixtureSocket.onmessage({data:JSON.stringify({event:'sendToPropertyInspector',payload:{event:'status',connected:false,message:'Open Voxincarnate and enable its local control API.',characters:[]}})})`);
    await fs.writeFile(path.join(output, 'streamdeck-inspector-disconnected.png'), (await inspector.webContents.capturePage()).toPNG());
    report.pluginInspectorUi = true;
  } catch (error) { report.ok = false; report.error = error instanceof Error ? error.stack : String(error); await screenshot('controls-failure.png').catch(() => undefined); }
  finally { inspector?.destroy(); if (fixture) await new Promise<void>(resolve => fixture!.close(() => resolve())); }
  return report;
}
