import { useEffect, useRef, useState } from 'react';
import { version as appVersion } from '../../package.json';
import type { Bootstrap, Character, Sprite, AppSettings, BrowserStatus, InputDevice, DetectorSettings } from '../shared';
import { spriteUrl, overlayUrl } from '../shared';
import { AudioEngine } from '../audio/engine';
declare global { interface Window { vox?: import('../shared').DesktopApi } }
type Level = { level: number; db: number; speaking: boolean };
const silent: Level = { level: 0, db: -120, speaking: false };
const iconPaths: Record<string, string> = {
  sound: 'M4 10v4h4l5 4V6l-5 4H4m12-2a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  plus: 'M12 5v14M5 12h14', copy: 'M9 9h11v11H9zM5 15H3V3h12v2',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5m-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8',
  browser: 'M3 4h18v16H3zM3 9h18M7 6h.1M10 6h.1',
  arrow: 'M14 6l-6 6 6 6', refresh: 'M20 11a8 8 0 1 0-2 6M20 4v7h-7',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  check: 'm5 12 4 4 10-10', play: 'm8 4 12 8-12 8z', stop: 'M6 6h12v12H6z',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6', close: 'm6 6 12 12M6 18 18 6'
};
function Icon({ name }: { name: string }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name] || iconPaths.sound} /></svg>; }

function Avatar({ data, character, speaking, frameIndex, selected }: {
  data: Bootstrap; character: Character; speaking: boolean; frameIndex: number; selected?: Sprite;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const resize = () => { if (area.current) setFit(Math.min(area.current.clientWidth / character.width, area.current.clientHeight / character.height) * .88); };
    const observer = new ResizeObserver(resize); if (area.current) observer.observe(area.current); resize();
    return () => observer.disconnect();
  }, [character.width, character.height]);
  const frames = speaking ? character.open : character.closed;
  const frame = selected || frames[frameIndex % Math.max(frames.length, 1)];
  return <div className="avatar-space" ref={area}>
    {frame ? <div className="avatar-canvas" style={{ width: character.width, height: character.height, transform: `translate(-50%, -50%) scale(${fit})` }}>
      <img key={frame.file} src={spriteUrl(data, character.id, frame)} alt={`${character.name}, ${speaking ? 'open' : 'closed'} mouth`}
        style={{ transform: `translate(-50%, -50%) translate(${frame.x}px, ${frame.y}px) scale(${frame.scale})` }} />
    </div> : <div className="empty-stage"><Icon name="upload" /><h2>Your character starts here</h2><p>Add a closed-mouth image and an open-mouth image in the builder.</p></div>}
  </div>;
}

export default function App() {
  const [data, setData] = useState<Bootstrap>();
  const [draft, setDraft] = useState<Character>();
  const [settings, setSettings] = useState<AppSettings>();
  const [dirty, setDirty] = useState(false);
  const [editor, setEditor] = useState(false);
  const [view, setView] = useState<'avatar' | 'browser'>('avatar');
  const [pose, setPose] = useState<'closed' | 'open'>('closed');
  const [selectedFrame, setSelectedFrame] = useState<string>();
  const [manual, setManual] = useState<'auto' | 'closed' | 'open'>('auto');
  const [frameIndex, setFrameIndex] = useState(0);
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [browser, setBrowser] = useState<BrowserStatus>({ url: '' });
  const [level, setLevel] = useState<Level>(silent);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const engine = useRef<AudioEngine | undefined>(undefined);
  const browserArea = useRef<HTMLDivElement>(null);
  const activeId = useRef('');

  useEffect(() => {
    if (!window.vox) { setError('Open Voxincarnate as a desktop application using npm start. This browser preview cannot access desktop files or embedded audio.'); return; }
    let disposed = false;
    window.vox.bootstrap().then(value => {
      if (disposed) return; setData(value); setSettings(value.settings);
      setDraft(value.characters.find(c => c.id === value.settings.activeCharacterId) || value.characters[0]);
      activeId.current = value.settings.activeCharacterId; engine.current = new AudioEngine(value.settings.detector);
      if (value.settings.mode === 'browser') {
        setView('browser');
        void window.vox!.browser('navigate', value.settings.assistantUrl).catch(e => setError(e.message));
      }
      void navigator.mediaDevices.enumerateDevices().then(list => {
        if (!disposed) setDevices(list.filter(d => d.kind === 'audioinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}` })));
      }).catch(() => undefined);
    }).catch(e => setError(e.message));
    const unsubscribe = window.vox.onBrowserStatus(value => setBrowser(previous => ({ ...previous, ...value })));
    return () => { disposed = true; unsubscribe(); void engine.current?.stop(); };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setFrameIndex(i => i + 1), draft?.frameMs || 180);
    return () => clearInterval(timer);
  }, [draft?.frameMs]);
  useEffect(() => {
    const update = () => {
      const rect = browserArea.current?.getBoundingClientRect();
      window.vox?.browserBounds({ x: rect?.x || 0, y: rect?.y || 0, width: rect?.width || 0, height: rect?.height || 0,
        visible: view === 'browser' && settings?.mode === 'browser' && !editor && !!rect && rect.top >= 72 && rect.bottom <= window.innerHeight });
    };
    const observer = new ResizeObserver(update); if (browserArea.current) observer.observe(browserArea.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [view, settings?.mode, editor, error, notice]);
  useEffect(() => {
    const onClose = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', onClose); return () => window.removeEventListener('beforeunload', onClose);
  }, [dirty]);

  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const stop = async () => {
    await engine.current?.stop(); await window.vox?.browser('stop'); setRunning(false); setLevel(silent);
    if (activeId.current) window.vox?.publish({ characterId: activeId.current, ...silent, running: false });
  };
  const changeMode = (mode: AppSettings['mode']) => void perform(async () => {
    if (!settings) return; await stop(); const next = { ...settings, mode }; setSettings(next);
    setData(await window.vox!.saveSettings(next));
    if (mode === 'browser') { setView('browser'); if (!browser.url) await window.vox!.browser('navigate', next.assistantUrl); }
    else setView('avatar');
  });
  const patchCharacter = (patch: Partial<Character>) => { setDraft(current => current && { ...current, ...patch }); setDirty(true); };
  const patchDetector = (patch: Partial<DetectorSettings>) => {
    if (!settings) return; const next = { ...settings, detector: { ...settings.detector, ...patch } };
    setSettings(next); engine.current?.setSettings(next.detector); setDirty(true);
  };
  const save = () => void perform(async () => {
    if (!draft || !settings) return;
    let updated = await window.vox!.saveCharacter(draft);
    updated = await window.vox!.saveSettings({ ...settings, activeCharacterId: draft.id });
    setData(updated); setSettings(updated.settings); activeId.current = draft.id; setDirty(false); setNotice('Character and settings saved.');
  });
  const choose = (character: Character) => void perform(async () => {
    if (dirty && !window.confirm('Discard your unsaved character or settings changes?')) return;
    await stop(); setDraft(structuredClone(character)); setDirty(false); setSelectedFrame(undefined);
    activeId.current = character.id;
    if (data) { const next = { ...data.settings, activeCharacterId: character.id }; setSettings(next); engine.current?.setSettings(next.detector); setData(await window.vox!.saveSettings(next)); }
  });
  const create = () => void perform(async () => {
    if (dirty && !window.confirm('Discard your unsaved character or settings changes?')) return;
    await stop();
    if (data) { setSettings(structuredClone(data.settings)); engine.current?.setSettings(data.settings.detector); }
    setDraft({ id: crypto.randomUUID(), name: 'New character', width: 600, height: 600, closed: [], open: [], frameMs: 180 });
    setDirty(true); setEditor(true); setView('avatar'); setSelectedFrame(undefined);
  });
  const addImages = () => void perform(async () => {
    if (!draft) return; const imported = await window.vox!.importImages(draft.id, pose);
    if (imported.length) { patchCharacter({ [pose]: [...draft[pose], ...imported] }); setSelectedFrame(imported[0].id); }
  });
  const refreshInputs = () => void perform(async () => {
    if (settings?.mode === 'browser') { setBrowser(previous => ({ ...previous, error: '', message: 'Checking the assistant browser for microphone inputs…' })); await window.vox!.browser('devices'); return; }
    const permission = await navigator.mediaDevices.getUserMedia({ audio: true }); permission.getTracks().forEach(t => t.stop());
    const list = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    setDevices(list.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Audio input ${i + 1}` })));
    if (settings && !list.some(d => d.deviceId === settings.inputId)) { setSettings({ ...settings, inputId: list[0]?.deviceId || '' }); setDirty(true); }
    setNotice('Inputs refreshed. Choose the source to animate.');
  });
  const start = () => void perform(async () => {
    if (!settings || !draft || !engine.current) return;
    if (dirty) throw new Error('Save your changes before starting audio.');
    activeId.current = draft.id; setManual('auto');
    const onLevel = (value: Level) => { setLevel(value); window.vox!.publish({ characterId: activeId.current, ...value, running: true }); };
    const ended = (message?: string) => { setRunning(false); setLevel(silent); if (message) setError(message);
      window.vox!.publish({ characterId: activeId.current, ...silent, running: false }); void window.vox!.browser('stop'); };
    try {
      if (settings.mode === 'direct') {
        if (!settings.inputId) throw new Error('Refresh inputs and choose an audio source first.');
        await engine.current.startDirect(settings.inputId, onLevel, ended);
      } else {
        if (!settings.browserInputId || !browser.devices?.some(d => d.deviceId === settings.browserInputId)) throw new Error('Enable inputs in the assistant browser, then choose its microphone.');
        await window.vox!.browser('input', settings.browserInputId);
        await engine.current.startBrowser(onLevel, ended);
      }
      setRunning(true);
    } catch (e) { await stop(); throw e; }
  });
  const updateSprite = (patch: Partial<Sprite>) => {
    if (!draft || !selectedFrame) return;
    patchCharacter({ [pose]: draft[pose].map(f => f.id === selectedFrame ? { ...f, ...patch } : f) });
  };

  if (!data || !draft || !settings) return <main className="loading-screen"><Icon name="sound" /><h1>Voxincarnate</h1><p role={error ? 'alert' : 'status'}>{error || 'Opening your studio…'}</p></main>;
  const inputList = settings.mode === 'browser' ? browser.devices || [] : devices;
  const inputId = settings.mode === 'browser' ? settings.browserInputId : settings.inputId;
  const picked = draft[pose].find(f => f.id === selectedFrame);
  const speaking = manual === 'auto' ? level.speaking : manual === 'open';
  const isNew = !data.characters.some(c => c.id === draft.id);
  return <div className="studio" data-ready="true">
    <header className="topbar">
      <div className="wordmark"><span className="brand-icon"><Icon name="sound" /></span><strong>Voxincarnate</strong><span className="app-version">STUDIO</span></div>
      <div className="session-status"><span className={`status-dot ${running ? 'live' : ''}`} />{running ? 'Audio active' : 'Ready when you are'}</div>
      <span className="save-state">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <button className="primary save-button" disabled={busy || !dirty || !draft.closed.length || !draft.open.length} onClick={save}><Icon name="check" />Save changes</button>
    </header>
    <aside className="library">
      <div className="section-title"><h2>Characters</h2><span>{data.characters.length}</span></div>
      <button className="add-character" onClick={create} disabled={busy || running}><Icon name="plus" />New character</button>
      <nav aria-label="Character library">{data.characters.map(character => <button key={character.id} className={`character-item ${draft.id === character.id ? 'selected' : ''}`} onClick={() => choose(character)} disabled={busy}>
        <span className="character-thumb">{character.closed[0] && <img src={spriteUrl(data, character.id, character.closed[0])} alt="" />}</span>
        <span><strong>{character.name}</strong><small>{character.closed.length + character.open.length} images</small></span>
      </button>)}</nav>
      <div className="library-note"><Icon name="sound" /><p>A little character.<br />A voice of its own.</p></div>
      <p className="local-note">Characters stay on this computer.</p>
    </aside>
    <main className="main-area">
      <div className="character-heading"><div><h1>{draft.name}</h1><p>{editor ? 'Build a character that feels like you.' : 'Your character, ready for the conversation.'}</p></div>
        <button className={editor ? 'secondary active' : 'secondary'} onClick={() => { setEditor(!editor); setView('avatar'); setSelectedFrame(undefined); }} disabled={running}><Icon name="settings" />{editor ? 'Close builder' : 'Edit character'}</button></div>
      {(error || notice) && <div className={`message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" /></button></div>}
      <div className="workspace">
        <section className="stage-panel" aria-label="Character preview">
          <div className="stage-toolbar"><div className="tabs"><button className={view === 'avatar' ? 'active' : ''} onClick={() => setView('avatar')}>Avatar preview</button>
            {settings.mode === 'browser' && !editor && <button className={view === 'browser' ? 'active' : ''} onClick={() => setView('browser')}>Assistant browser</button>}</div>
            <span className="canvas-size">{draft.width} × {draft.height}</span></div>
          <div className={`stage ${view === 'browser' && !editor ? 'with-browser' : ''}`}>
            <Avatar data={data} character={draft} speaking={editor ? pose === 'open' : speaking} frameIndex={frameIndex} selected={editor ? picked : undefined} />
            <div ref={browserArea} className="browser-area" aria-label="Embedded assistant browser" hidden={view !== 'browser' || editor} />
            {view === 'avatar' && <div className="stage-label"><span className={`status-dot ${speaking ? 'live' : ''}`} />{speaking ? 'Speaking' : 'Idle'}<span>Transparent canvas</span></div>}
          </div>
          <div className="preview-controls"><span>Preview mouth</span><div className="segmented">{(['auto', 'closed', 'open'] as const).map(value => <button key={value} className={manual === value ? 'active' : ''} onClick={() => setManual(value)} disabled={editor}>{value === 'auto' ? 'Audio' : value === 'closed' ? 'Closed' : 'Open'}</button>)}</div><span className="preview-note">Preview controls stay out of OBS</span></div>
        </section>
        <aside className="inspector">
          <section className="audio-panel"><h2>Bring it to life</h2><p className="muted">Choose what your character listens to.</p>
            <div className="mode-options"><button className={settings.mode === 'direct' ? 'chosen' : ''} onClick={() => changeMode('direct')} disabled={busy}><Icon name="mic" /><span><strong>Direct audio</strong><small>Animate from an input</small></span></button>
              <button className={settings.mode === 'browser' ? 'chosen' : ''} onClick={() => changeMode('browser')} disabled={busy}><Icon name="browser" /><span><strong>Assistant browser</strong><small>Animate the assistant’s voice</small></span></button></div>
            {settings.mode === 'browser' && <div className="browser-settings"><label htmlFor="assistant-url">Assistant website</label><div className="url-row"><input id="assistant-url" type="url" value={settings.assistantUrl} onChange={e => { setSettings({ ...settings, assistantUrl: e.target.value }); setDirty(true); }} /><button className="icon-button" title="Open assistant" aria-label="Open assistant" disabled={busy || running} onClick={() => void perform(async () => { await window.vox!.browser('navigate', settings.assistantUrl); setView('browser'); })}><Icon name="browser" /></button></div>
              <div className="browser-nav"><button aria-label="Back" onClick={() => void perform(() => window.vox!.browser('back'))}><Icon name="arrow" /></button><button aria-label="Reload assistant" onClick={() => void perform(() => window.vox!.browser('reload'))}><Icon name="refresh" /></button><span>{browser.loading ? 'Loading website…' : browser.url ? 'Website open' : 'Open the website to begin'}</span></div>
              <p className="helper">Select a microphone, save, then capture assistant audio before starting the site’s voice call. Sign-in and guest access are managed by the website.</p></div>}
            <div className="label-row"><label htmlFor="audio-input">{settings.mode === 'browser' ? 'Microphone sent to assistant' : 'Audio input'}</label><button className="text-button" onClick={refreshInputs} disabled={busy || running}>Enable / refresh</button></div>
            <select id="audio-input" value={inputId} disabled={running || busy} onChange={e => { const field = settings.mode === 'browser' ? 'browserInputId' : 'inputId'; setSettings({ ...settings, [field]: e.target.value }); setDirty(true); }}><option value="">Choose an input…</option>{inputList.map(d => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}</select>
            {settings.mode === 'browser' && <p className="helper">The browser’s response drives the avatar. Your input is kept separate.{browser.actualInput && <><br />Verified input: {browser.actualInput}</>}</p>}
            {browser.error && settings.mode === 'browser' && <p className="inline-error" role="alert">{browser.error}</p>}
            {browser.message && !browser.error && settings.mode === 'browser' && <p className="helper" role="status">{browser.message}</p>}
            <div className="level-label"><span>{settings.mode === 'browser' ? 'Assistant output' : 'Input level'}</span><span>{running ? `${Math.round(level.db)} dB` : 'No audio'}</span></div>
            <meter min={-70} max={0} low={-50} high={-10} optimum={-25} value={level.db} aria-label="Audio level" />
            <button className={`transport ${running ? 'secondary' : 'primary'}`} disabled={busy || isNew} onClick={running ? () => void perform(stop) : start}><Icon name={running ? 'stop' : 'play'} />{busy ? 'Please wait…' : running ? 'Stop audio' : settings.mode === 'browser' ? 'Capture assistant audio' : 'Start audio'}</button>
            <details className="audio-tuning"><summary>Audio response</summary>
              <label htmlFor="sensitivity">Mouth opens above <span>{settings.detector.openThresholdDb} dB</span></label><input id="sensitivity" type="range" min="-60" max="-10" value={settings.detector.openThresholdDb} onChange={e => { const db = Number(e.target.value); patchDetector({ openThresholdDb: db, closeThresholdDb: db - 7 }); }} />
              <label htmlFor="gain">Input gain <span>{settings.detector.gain.toFixed(1)}×</span></label><input id="gain" type="range" min="0.2" max="5" step="0.1" value={settings.detector.gain} onChange={e => patchDetector({ gain: Number(e.target.value) })} />
              <label htmlFor="hold">Mouth hold <span>{settings.detector.holdMs} ms</span></label><input id="hold" type="range" min="0" max="300" step="10" value={settings.detector.holdMs} onChange={e => patchDetector({ holdMs: Number(e.target.value) })} />
            </details>
          </section>
          <section className="obs-panel"><h2>Take it to OBS</h2><p>Add a Browser Source and paste this character’s URL.</p>
            <code className="overlay-address" title={overlayUrl(data, draft.id)}>{data.overlayOrigin}/overlay/{draft.id.slice(0, 8)}…</code>
            <button className="secondary wide" disabled={isNew || busy} onClick={() => void perform(async () => { await window.vox!.copy(overlayUrl(data, draft.id)); setNotice('OBS URL copied. Add a Browser Source with this URL.'); })}><Icon name="copy" />Copy OBS URL</button>
            <dl><div><dt>Canvas</dt><dd>{draft.width} × {draft.height}</dd></div><div><dt>Background</dt><dd>Transparent</dd></div><div><dt>Output</dt><dd>Avatar only</dd></div></dl>
            <p className="helper">Capture the app’s audio separately in OBS. Transparent PNGs keep the character’s background clear.</p>
          </section>
        </aside>
      </div>
      {editor && <section className="builder"><div className="builder-header"><h2>Character builder</h2><span>At least one image for each mouth pose</span></div>
        <div className="character-fields"><label>Name<input value={draft.name} maxLength={80} onChange={e => patchCharacter({ name: e.target.value })} /></label><label>Canvas width<input type="number" min="64" max="4096" value={draft.width} onChange={e => patchCharacter({ width: Number(e.target.value) })} /></label><label>Canvas height<input type="number" min="64" max="4096" value={draft.height} onChange={e => patchCharacter({ height: Number(e.target.value) })} /></label><label>Frame interval (ms)<input type="number" min="60" max="5000" value={draft.frameMs} onChange={e => patchCharacter({ frameMs: Number(e.target.value) })} /></label></div>
        <div className="builder-tools"><div className="tabs">{(['closed', 'open'] as const).map(p => <button key={p} className={pose === p ? 'active' : ''} onClick={() => { setPose(p); setSelectedFrame(undefined); }}>{p === 'closed' ? 'Closed mouth' : 'Open mouth'} <span>{draft[p].length}</span></button>)}</div><button className="secondary" onClick={addImages} disabled={busy}><Icon name="upload" />Add images</button></div>
        <div className="frame-list">{draft[pose].map((frame, index) => <div className={`frame ${frame.id === selectedFrame ? 'selected' : ''}`} key={frame.id}><button className="frame-select" onClick={() => setSelectedFrame(frame.id)}><img src={spriteUrl(data, draft.id, frame)} alt={frame.name} /><span>{index === 0 ? 'Default · ' : ''}{frame.name}</span></button><div className="frame-actions"><button disabled={index === 0} onClick={() => { const list = [...draft[pose]]; [list[index - 1], list[index]] = [list[index], list[index - 1]]; patchCharacter({ [pose]: list }); }}>Move earlier</button><button onClick={() => { patchCharacter({ [pose]: draft[pose].filter(f => f.id !== frame.id) }); if (selectedFrame === frame.id) setSelectedFrame(undefined); }}>Remove</button></div></div>)}{!draft[pose].length && <p className="empty-frames">Add PNG or JPEG images for this pose. Transparent PNGs work best for OBS.</p>}</div>
        {picked && <div className="alignment"><strong>Align {picked.name}</strong><label>Horizontal offset<input type="number" min="-4096" max="4096" value={picked.x} onChange={e => updateSprite({ x: Number(e.target.value) })} /></label><label>Vertical offset<input type="number" min="-4096" max="4096" value={picked.y} onChange={e => updateSprite({ y: Number(e.target.value) })} /></label><label>Scale<input type="range" min="0.1" max="4" step="0.05" value={picked.scale} onChange={e => updateSprite({ scale: Number(e.target.value) })} /></label><button className="text-button" onClick={() => updateSprite({ x: 0, y: 0, scale: 1 })}>Reset alignment</button></div>}
      </section>}
      <footer className="studio-footer"><span><span className={`status-dot ${running ? 'live' : ''}`} />{running ? 'Sending animation to OBS' : 'OBS overlay available'}</span><span>Voxincarnate {appVersion} · Windows desktop</span></footer>
    </main>
  </div>;
}
