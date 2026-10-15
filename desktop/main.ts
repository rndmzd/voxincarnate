import { app, BrowserWindow, WebContentsView, ipcMain, dialog, nativeImage, clipboard, session } from 'electron';
import type { IpcMainInvokeEvent, IpcMainEvent, Rectangle } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { LibraryStore } from './library';
import { OverlayServer } from './overlay';
import { runSmoke } from './smoke';
import { overlayUrl } from './shared';
import type { AppSettings, AvatarState, Bootstrap, BrowserStatus, Character } from './shared';

const smoke = process.argv.includes('--smoke-test');
const tabOnly = process.argv.includes('--tab-capture-only');
if (smoke) {
  app.setPath('userData', path.join(process.cwd(), '.qa', 'profile'));
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
    assertTrusted(e); await store.saveCharacter(character); overlay.refresh(); return bootstrap();
  });
  ipcMain.handle('settings:save', async (e, settings: AppSettings) => {
    assertTrusted(e);
    if (settings.overlayPort !== store.snapshot().settings.overlayPort) throw new Error('Changing the overlay port requires a restart.');
    await store.saveSettings(settings); if (settings.mode === 'direct') stopBrowserMic();
    overlay.refresh(); return bootstrap();
  });
  ipcMain.handle('character:import', async (e, characterId: string, pose: string) => {
    assertTrusted(e); if (!['open', 'closed'].includes(pose)) throw new Error('Choose a mouth pose.');
    const result = await dialog.showOpenDialog(window, { title: `Add ${pose}-mouth images`,
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
  window.webContents.on('will-navigate', e => e.preventDefault());
  window.webContents.on('will-prevent-unload', event => {
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
  const result = await runSmoke({ window, createAssistant, setEnabled: value => { browserEnabled = value; browserAllowedOrigin = ''; },
    sendAssistant, overlayOrigin, bootstrap, outputDir: output, tabOnly });
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
  if (shuttingDown || !overlay || smoke) return;
  event.preventDefault(); shuttingDown = true; stopBrowserMic();
  void overlay.stop().finally(() => app.quit());
});
void main().catch(error => {
  console.error(error);
  if (!smoke) dialog.showErrorBox('Voxincarnate could not start', `${error.message}\nClose another running copy or check that the application data folder is writable.`);
  app.exit(1);
});
