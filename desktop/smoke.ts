import { app, BrowserWindow, ipcMain, type WebContentsView } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import type { Bootstrap } from './shared';

interface SmokeOptions {
  window: BrowserWindow;
  createAssistant: () => WebContentsView;
  setEnabled: (enabled: boolean) => void;
  sendAssistant: (type: 'devices' | 'input' | 'stop', id?: string) => void;
  overlayOrigin: string;
  bootstrap: () => Bootstrap;
  outputDir: string;
  tabOnly?: boolean;
}

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function bounded<T>(operation: Promise<T>, message: string, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${message} timed out.`)), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Microphone checks require fake devices; tab-only checks open no microphone. */
export async function runSmoke(options: SmokeOptions): Promise<Record<string, unknown>> {
  const { window: studio, createAssistant, setEnabled, sendAssistant, outputDir } = options;
  if (!process.argv.includes('--smoke-test') || path.relative(path.join(process.cwd(), '.qa', 'profile'), app.getPath('userData')) !== '') {
    throw new Error('Smoke tests require --smoke-test and the repository-local .qa/profile test profile.');
  }
  const fakeDevices = app.commandLine.hasSwitch('use-fake-device-for-media-stream');
  if (!options.tabOnly && !fakeDevices) {
    throw new Error('Smoke tests require Chromium fake media devices; physical microphone capture is not allowed.');
  }
  if (options.tabOnly && fakeDevices) {
    throw new Error('Tab-only smoke must run without fake media devices so it can validate the actual embedded tab capture.');
  }
  await fs.mkdir(outputDir, { recursive: true });
  const result: Record<string, unknown> = { ok: true, overlayOrigin: options.overlayOrigin, tabOnly: options.tabOnly === true, fakeDevices };
  const trace: { source: string; event: string; text: string }[] = [];
  let assistant: WebContentsView | undefined;
  let unrelated: BrowserWindow | undefined;
  const cleanupListeners: (() => void)[] = [];
  const listen = (wc: Electron.WebContents, source: string) => {
    const consoleListener = (event: unknown, _level?: number, message?: string) => {
      const text = typeof message === 'string' ? message :
        event && typeof event === 'object' && 'message' in event ? String(event.message) : 'Browser console event';
      if (trace.length < 100) trace.push({ source, event: 'console', text: text.slice(0, 500) });
    };
    const preloadListener = (_event: unknown, filename: string, error: Error) => {
      if (trace.length < 100) trace.push({ source, event: 'preload-error', text: `${filename}: ${error.message}`.slice(0, 500) });
    };
    wc.on('console-message', consoleListener);
    wc.on('preload-error', preloadListener);
    cleanupListeners.push(() => {
      if (!wc.isDestroyed()) { wc.removeListener('console-message', consoleListener); wc.removeListener('preload-error', preloadListener); }
    });
  };
  listen(studio.webContents, 'studio');
  const evaluate = <T = unknown>(script: string, gesture = true) =>
    bounded(studio.webContents.executeJavaScript(script, gesture) as Promise<T>, 'Studio script');
  const waitFor = async (expression: string, message: string, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await evaluate<boolean>(`Boolean(${expression})`, false)) return;
      await delay(80);
    }
    throw new Error(message);
  };
  const click = async (selector: string) => {
    await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button || button.disabled)throw new Error('Button unavailable: '+${JSON.stringify(selector)});button.click()})()`);
  };
  const select = async (value: string) => {
    await evaluate(`(()=>{const select=document.querySelector('#audio-input');if(!select || select.disabled)throw new Error('Input picker unavailable');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(value)});select.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  };
  const step = async (name: string, operation: () => Promise<unknown>) => {
    try { result[name] = await operation(); }
    catch (error) {
      result.ok = false;
      result[name] = { ...(result[name] && typeof result[name] === 'object' ? result[name] as Record<string, unknown> : {}),
        ok: false, error: error instanceof Error ? error.stack : String(error) };
    }
  };
  const screenshot = async (name: string) => {
    try {
      await evaluate(`(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode().catch(()=>{})));await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))})()`, false);
      const destination = path.join(outputDir, name);
      await fs.writeFile(destination, (await bounded(studio.webContents.capturePage(), 'Screenshot')).toPNG());
      return destination;
    } catch (error) { return { error: String(error) }; }
  };

  const fixture = createServer((request, response) => {
    const frequency = request.url === '/unrelated' ? 1200 : 440;
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><meta charset="utf-8"><title>Local smoke audio fixture</title><p>Deterministic ${frequency} Hz audio fixture.</p><script>window.fixtureContext=new AudioContext();window.fixtureOscillator=fixtureContext.createOscillator();fixtureOscillator.frequency.value=${frequency};window.fixtureGain=fixtureContext.createGain();fixtureGain.gain.value=.15;fixtureOscillator.connect(fixtureGain).connect(fixtureContext.destination);fixtureOscillator.start();fixtureContext.resume();</script>`);
  });
  try {
    await waitFor(`document.querySelector('[data-ready]')`, 'The compiled desktop UI did not load.');
    result.ui = await evaluate(`({title:document.title,ready:!!document.querySelector('[data-ready]'),characterImages:document.images.length})`);
    if (!options.tabOnly) await step('directAudio', async () => {
      await evaluate(`(()=>{const button=[...document.querySelectorAll('.mode-options button')].find(item=>item.textContent.includes('Direct audio'));if(!button)throw new Error('Direct audio mode missing');button.click()})()`);
      await waitFor(`document.querySelector('.mode-options button.chosen')?.textContent.includes('Direct audio') && !document.querySelector('.transport')?.disabled`, 'Direct mode did not become ready.');
      await click('.label-row .text-button');
      await waitFor(`document.querySelectorAll('#audio-input option').length>1 && !document.querySelector('#audio-input')?.disabled`, 'Fake audio inputs did not appear.');
      const deviceId = await evaluate<string>(`(()=>{const options=[...document.querySelectorAll('#audio-input option')];const item=options.find(option=>option.value && option.value!=='default' && option.value!=='communications');if(!item)throw new Error('No concrete fake input');return item.value})()`);
      await select(deviceId);
      await waitFor(`!document.querySelector('.save-button')?.disabled`, 'Input change was not saved in UI state.');
      await click('.save-button');
      await waitFor(`document.querySelector('.save-state')?.textContent==='All changes saved' && !document.querySelector('.transport')?.disabled`, 'Input choice did not save.');
      await click('.transport');
      await waitFor(`document.querySelector('.transport')?.textContent.includes('Stop audio')`, 'Fake microphone capture did not start.');
      const maximumDb = await evaluate<number>(`(async()=>{let maximum=-120;for(let index=0;index<80;index++){maximum=Math.max(maximum,document.querySelector('meter').value);if(maximum>-60)return maximum;await new Promise(resolve=>setTimeout(resolve,75))}return maximum})()`);
      if (maximumDb <= -60) throw new Error(`Fake microphone did not reach the actual UI meter (maximum ${maximumDb} dB).`);
      await click('.transport');
      await waitFor(`document.querySelector('.transport')?.textContent.includes('Start audio') && !document.querySelector('.transport')?.disabled`, 'Direct capture did not stop.');
      return { ok: true, fakeDeviceId: deviceId, maximumDb };
    });

    // Reset through the same native picker/save controls, leaving repeat runs in
    // direct mode with no capture and no persisted device selection.
    if (!options.tabOnly) await step('directCleanup', async () => {
      if (await evaluate<boolean>(`document.querySelector('.transport')?.textContent.includes('Stop audio')`)) await click('.transport');
      await waitFor(`!document.querySelector('#audio-input')?.disabled`, 'Input picker did not unlock after stopping.');
      const current = await evaluate<string>(`document.querySelector('#audio-input').value`);
      if (current) {
        await select('');
        await waitFor(`!document.querySelector('.save-button')?.disabled`, 'Clearing the input did not update UI state.');
        await click('.save-button');
        await waitFor(`document.querySelector('.save-state')?.textContent==='All changes saved' && !document.querySelector('.transport')?.disabled`, 'Cleared input did not persist.');
      }
      const state = options.bootstrap().settings;
      if (state.mode !== 'direct' || state.inputId) throw new Error('Smoke left a selected audio source in saved settings.');
      return { ok: true, mode: state.mode, inputId: state.inputId };
    });
    if (options.tabOnly) {
      result.directAudio = { skipped: true, reason: 'Tab-only process opens no microphone.' };
      result.directCleanup = { skipped: true, reason: 'Tab-only process does not modify saved input settings.' };
    }

    studio.setSize(1440, 960);
    await evaluate(`window.scrollTo(0,0)`);
    result.desktopScreenshot = await screenshot('desktop.png');
    await step('builderUi', async () => {
      await evaluate(`(()=>{const button=[...document.querySelectorAll('.character-heading button')].find(item=>item.textContent.includes('Edit character'));if(!button)throw new Error('Character builder button missing');button.click()})()`);
      await waitFor(`document.querySelector('.builder')`, 'Character builder did not open.');
      await evaluate(`document.querySelector('.builder').scrollIntoView({block:'end'})`);
      result.builderScreenshot = await screenshot('builder.png');
      const fields = await evaluate<number>(`document.querySelectorAll('.builder input').length`);
      await click('.character-heading button');
      await waitFor(`!document.querySelector('.builder')`, 'Character builder did not close.');
      return { ok: true, visibleFields: fields };
    });
    studio.setSize(1120, 740);
    await evaluate(`window.scrollTo(0,0)`);
    result.minimumScreenshot = await screenshot('desktop-minimum.png');
    studio.setSize(1440, 960);

    await bounded(new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(0, '127.0.0.1', () => { fixture.removeListener('error', reject); resolve(); });
    }), 'Local audio fixture startup');
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Local audio fixture did not bind.');
    const fixtureOrigin = `http://127.0.0.1:${address.port}`;
    assistant = createAssistant();
    listen(assistant.webContents, 'assistant');
    setEnabled(false);
    await bounded(assistant.webContents.loadURL(fixtureOrigin), 'Assistant fixture navigation');
    const assistantScript = <T = unknown>(script: string) => bounded(assistant!.webContents.executeJavaScript(script, true) as Promise<T>, 'Assistant fixture script');
    const waitStatus = (predicate: (status: Record<string, unknown>) => boolean) => bounded(new Promise<Record<string, unknown>>(resolve => {
      const listener = (event: Electron.IpcMainEvent, value: unknown) => {
        if (event.sender !== assistant!.webContents || !value || typeof value !== 'object') return;
        const status = value as Record<string, unknown>;
        if (predicate(status)) { ipcMain.removeListener('assistant:status', listener); resolve(status); }
      };
      ipcMain.on('assistant:status', listener);
      cleanupListeners.push(() => ipcMain.removeListener('assistant:status', listener));
    }), 'Assistant adapter status');

    await step('browserStatusUi', async () => {
      const savedSettings = structuredClone(options.bootstrap().settings);
      const reloadStudio = async () => {
        let loaded: () => void = () => {};
        const finished = new Promise<void>(resolve => {
          loaded = resolve;
          studio.webContents.once('did-finish-load', loaded);
        });
        try {
          studio.webContents.reload();
          await bounded(finished, 'Studio reload for browser status check');
        } finally { studio.webContents.removeListener('did-finish-load', loaded); }
        await waitFor(`document.querySelector('[data-ready]')`, 'Studio did not restore after the browser status check.');
      };
      const diagnostic = 'Smoke check: microphone discovery failed.';
      const recovered = 'Smoke check: microphone discovery recovered.';
      const retainsDiagnostic = `document.querySelector('.inline-error')?.textContent===${JSON.stringify(diagnostic)} && document.querySelector('#audio-input option[value="smoke-status-input"]')?.textContent==='Smoke status input'`;
      setEnabled(false);
      try {
        // Reload from temporary QA settings so production React/preload handle
        // the actual IPC messages. This never enables or opens a microphone.
        await evaluate(`window.vox.saveSettings(${JSON.stringify({ ...savedSettings, mode: 'browser', assistantUrl: fixtureOrigin })})`);
        await reloadStudio();
        await waitFor(`document.querySelector('#assistant-url')?.value===${JSON.stringify(fixtureOrigin)} && document.querySelector('.browser-nav span')?.textContent==='Website open'`, 'Local browser fixture did not become ready for the status check.');
        studio.webContents.send('browser:status', { url: fixtureOrigin, error: diagnostic,
          devices: [{ deviceId: 'smoke-status-input', label: 'Smoke status input' }] });
        await waitFor(retainsDiagnostic, 'Browser error and device status did not appear in the compiled UI.');

        studio.webContents.send('browser:status', { url: fixtureOrigin, loading: true });
        await waitFor(`document.querySelector('.browser-nav span')?.textContent==='Loading website…'`, 'Loading-only browser status did not reach the compiled UI.');
        if (!await evaluate<boolean>(retainsDiagnostic)) throw new Error('A partial loading status cleared the browser error or audio inputs.');
        studio.webContents.send('browser:status', { url: `${fixtureOrigin}/status-check` });
        studio.webContents.send('browser:status', { url: fixtureOrigin, loading: false });
        await waitFor(`document.querySelector('.browser-nav span')?.textContent==='Website open'`, 'URL/loading recovery did not reach the compiled UI.');
        if (!await evaluate<boolean>(retainsDiagnostic)) throw new Error('Partial URL/loading statuses cleared the browser error or audio inputs.');

        studio.webContents.send('browser:status', { url: fixtureOrigin, error: '', message: recovered });
        await waitFor(`!document.querySelector('.inline-error') && [...document.querySelectorAll('.helper[role="status"]')].some(item=>item.textContent===${JSON.stringify(recovered)})`, 'Explicit browser recovery did not clear the error and display its message.');
        if (!await evaluate<boolean>(`!!document.querySelector('#audio-input option[value="smoke-status-input"]')`)) throw new Error('An error recovery status cleared the audio input list.');
      } finally {
        setEnabled(false);
        await evaluate(`window.vox.saveSettings(${JSON.stringify(savedSettings)})`);
        // Reset the injected transient browser diagnostics as well as restoring
        // saved settings; subsequent steps receive only genuine page status.
        await reloadStudio();
        if (JSON.stringify(options.bootstrap().settings) !== JSON.stringify(savedSettings)) throw new Error('Browser status check did not restore the saved test settings.');
      }
      return { ok: true, partialStatusPreservedError: true, partialStatusPreservedInputs: true,
        explicitRecoveryClearedError: true, savedSettingsRestored: true, openedMicrophone: false };
    });
    setEnabled(false);
    await bounded(assistant.webContents.loadURL(fixtureOrigin), 'Assistant fixture navigation after browser status check');

    if (!options.tabOnly) await step('assistantMicrophone', async () => {
      const blocked = await assistantScript<string>(`navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return 'unexpectedly granted'},error=>error.name)`);
      if (blocked !== 'NotAllowedError') throw new Error(`Disabled assistant microphone returned ${blocked}.`);
      setEnabled(true);
      const deviceStatus = waitStatus(value => Array.isArray(value.devices) && value.devices.length > 0);
      sendAssistant('devices');
      const devices = (await deviceStatus).devices as { deviceId: string; label: string }[];
      const picked = devices.find(device => device.deviceId && !['default', 'communications'].includes(device.deviceId));
      if (!picked) throw new Error('Assistant adapter returned no concrete own-origin fake microphone.');
      const selected = waitStatus(value => typeof value.message === 'string' && value.message.startsWith('Microphone selected.'));
      sendAssistant('input', picked.deviceId);
      await selected;
      const actual = await assistantScript<{ deviceId: string; label: string }>(`(async()=>{window.smokeMic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false}});const track=smokeMic.getAudioTracks()[0];return {deviceId:track.getSettings().deviceId,label:track.label}})()`);
      if (actual.deviceId !== picked.deviceId) throw new Error('Actual browser microphone did not match the selected origin device.');
      const camera = await assistantScript<string>(`navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return 'unexpectedly granted'},error=>error.name)`);
      if (camera !== 'NotAllowedError') throw new Error(`Assistant camera permission returned ${camera}.`);
      const stoppedStatus = waitStatus(value => value.message === 'Assistant microphone stopped.');
      sendAssistant('stop');
      await stoppedStatus;
      const stopped = await assistantScript<boolean>(`smokeMic.getTracks().every(track=>track.readyState==='ended')`);
      const deniedAfterStop = await assistantScript<string>(`navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return 'unexpectedly granted'},error=>error.name)`);
      if (!stopped || deniedAfterStop !== 'NotAllowedError') throw new Error('Assistant Stop failed to end tracks and reject subsequent capture.');
      setEnabled(false);
      return { ok: true, blocked, deviceCount: devices.length, selectedDeviceId: picked.deviceId, actual, camera, stopped, deniedAfterStop };
    });
    else result.assistantMicrophone = { skipped: true, reason: 'Tab-only process opens no microphone or camera.' };

    if (options.tabOnly) await step('tabCapture', async () => {
      const metrics: Record<string, unknown> = { capturedToneHz: 440, unrelatedToneHz: 1200 };
      result.tabCapture = metrics;
      setEnabled(true);
      assistant!.setBounds({ x: 0, y: 0, width: 640, height: 480 });
      assistant!.setVisible(true);
      await assistantScript(`fixtureContext.resume()`);
      unrelated = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: {
        partition: 'smoke-unrelated-audio', sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, offscreen: true
      } });
      listen(unrelated.webContents, 'unrelated');
      await bounded(unrelated.loadURL(`${fixtureOrigin}/unrelated`), 'Unrelated audio fixture navigation');
      await bounded(unrelated.webContents.executeJavaScript('fixtureContext.resume()', true), 'Unrelated fixture audio start');
      await evaluate(`(async()=>{
        const stream=await navigator.mediaDevices.getDisplayMedia({audio:true,video:true});
        if(!stream.getAudioTracks().length)throw new Error('No tab audio track');
        const context=new AudioContext();
        const analyser=context.createAnalyser();analyser.fftSize=8192;analyser.smoothingTimeConstant=0;
        const source=context.createMediaStreamSource(stream);
        const sink=context.createGain();sink.gain.value=0;
        source.connect(analyser).connect(sink).connect(context.destination);
        window.smokeCapture={stream,context,analyser,source,sink};
        await context.resume();
      })()`);
      const measure = () => evaluate<{ peak: number; targetDb: number; unrelatedDb: number; differenceDb: number }>(`(async()=>{const {analyser,context}=smokeCapture;const samples=new Float32Array(analyser.fftSize);const bins=new Float32Array(analyser.frequencyBinCount);let peak=0,targetDb=-160,unrelatedDb=-160;for(let index=0;index<20;index++){await new Promise(resolve=>setTimeout(resolve,50));analyser.getFloatTimeDomainData(samples);for(const sample of samples)peak=Math.max(peak,Math.abs(sample));analyser.getFloatFrequencyData(bins);for(const frequency of [440,1200]){const bin=Math.round(frequency/context.sampleRate*analyser.fftSize);const db=Math.max(...bins.slice(Math.max(0,bin-2),bin+3));if(frequency===440)targetDb=Math.max(targetDb,db);else unrelatedDb=Math.max(unrelatedDb,db)}}return {peak,targetDb,unrelatedDb,differenceDb:targetDb-unrelatedDb}})()`);
      const visible = await measure();
      metrics.visible = visible;
      assistant!.setVisible(false);
      const hidden = await measure();
      metrics.hidden = hidden;
      if (visible.peak < .01 || hidden.peak < .01) throw new Error('Embedded tab capture was silent while visible or hidden.');
      if (visible.differenceDb < 15 || hidden.differenceDb < 15) throw new Error('Tab audio did not isolate the 440 Hz fixture from unrelated 1200 Hz output.');
      await assistantScript('fixtureGain.gain.value=0');
      const silencedAssistant = await evaluate<{ settled: boolean; peak: number; elapsedMs: number; readings: unknown[] }>(`(async()=>{
        const {analyser,context,stream}=smokeCapture;
        const samples=new Float32Array(analyser.fftSize),bins=new Float32Array(analyser.frequencyBinCount);
        const started=performance.now(),audioStarted=context.currentTime;
        let quietStarted=null,quietAudioStarted=0,quietPeak=0,quietUnrelatedDb=-160;
        let maximumObservedPeak=0,finalPeak=0,settled=false;
        const readings=[];
        while(performance.now()-started<5000){
          await new Promise(resolve=>setTimeout(resolve,50));
          if(context.state!=='running'||!stream.getAudioTracks().every(track=>track.readyState==='live'))throw new Error('Capture stopped while checking silence');
          analyser.getFloatTimeDomainData(samples);analyser.getFloatFrequencyData(bins);
          let peak=0;for(const sample of samples)peak=Math.max(peak,Math.abs(sample));
          const band=frequency=>{const bin=Math.round(frequency/context.sampleRate*analyser.fftSize);return Math.max(...bins.slice(Math.max(0,bin-2),bin+3))};
          const elapsedMs=performance.now()-started,targetDb=band(440),unrelatedDb=band(1200);
          finalPeak=peak;maximumObservedPeak=Math.max(maximumObservedPeak,peak);
          readings.push({elapsedMs:Math.round(elapsedMs),audioTimeMs:Math.round((context.currentTime-audioStarted)*1000),peak,targetDb,unrelatedDb});
          if(peak<.002){
            if(quietStarted===null){quietStarted=performance.now();quietAudioStarted=context.currentTime;quietPeak=0;quietUnrelatedDb=-160}
            quietPeak=Math.max(quietPeak,peak);quietUnrelatedDb=Math.max(quietUnrelatedDb,unrelatedDb);
            if(performance.now()-quietStarted>=300&&(context.currentTime-quietAudioStarted)*1000>=300){settled=true;break}
          }else{quietStarted=null;quietPeak=0;quietUnrelatedDb=-160}
        }
        return {settled,peak:settled?quietPeak:finalPeak,maximumObservedPeak,finalPeak,
          elapsedMs:Math.round(performance.now()-started),quietMs:quietStarted===null?0:Math.round(performance.now()-quietStarted),
          audioAdvancedMs:Math.round((context.currentTime-audioStarted)*1000),quietUnrelatedDb,
          pollCount:readings.length,windowFrames:analyser.fftSize,sampleRate:context.sampleRate,readings};
      })()`);
      metrics.silencedAssistant = silencedAssistant;
      if (!silencedAssistant.settled) throw new Error('Captured audio did not remain below 0.002 for 300 ms within five seconds after muting the assistant while another window played.');
      return { ok: true, visible, hidden, silencedAssistant, unrelatedToneHz: 1200, capturedToneHz: 440, audioTracks: 1 };
    });
    else result.tabCapture = { skipped: true,
      reason: 'Fake-device mode cannot prove actual display-audio isolation; run --tab-capture-only in a separate process without the fake-device flag.' };
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.stack : String(error);
  } finally {
    try {
      await evaluate(`(async()=>{if(window.smokeCapture){smokeCapture.stream.getTracks().forEach(track=>track.stop());smokeCapture.source.disconnect();smokeCapture.analyser.disconnect();smokeCapture.sink.disconnect();await smokeCapture.context.close();delete window.smokeCapture}})()`);
    } catch { /* The renderer may have exited during a failed integration check. */ }
    setEnabled(false);
    try { sendAssistant('stop'); } catch { /* A failed/crashed page has no live adapter. */ }
    if (assistant && !assistant.webContents.isDestroyed()) {
      try { await bounded(assistant.webContents.loadURL('about:blank'), 'Fixture cleanup', 3000); } catch { /* Process shutdown also releases fixture media. */ }
      assistant.setVisible(false);
    }
    if (unrelated && !unrelated.isDestroyed()) unrelated.destroy();
    if (fixture.listening) await new Promise<void>(resolve => fixture.close(() => resolve()));
    for (const cleanup of cleanupListeners) cleanup();
    result.trace = trace;
  }
  return result;
}
