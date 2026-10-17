import { useEffect, useRef, useState } from 'react';
import { version as appVersion } from '../../package.json';
import type { Bootstrap, Character, Sprite, AppSettings, BrowserStatus, InputDevice, DetectorSettings, Articulation, AssetPose, CharacterPresence, MotionEffect } from '../shared';
import { spriteUrl, overlayUrl, VISEMES, VISEME_LABELS, spritesForPose as poseFrames, characterSprites as allFrames } from '../shared';
import { AudioEngine } from '../audio/engine';
import { createAvatarAnimator, createMotionAnimator, drawSmokePuff } from '../animation';
import { CharacterCreator } from './CharacterCreator';
declare global { interface Window { vox?: import('../shared').DesktopApi } }
type Level = { level: number; db: number; speaking: boolean; articulation?: Articulation; lipSyncError?: string };
const silent: Level = { level: 0, db: -120, speaking: false };
const frameKey = (frame?: Sprite) => frame ? `${frame.id}:${frame.file}:${frame.x}:${frame.y}:${frame.scale}` : '';
const iconPaths: Record<string, string> = {
  sound: 'M4 10v4h4l5 4V6l-5 4H4m12-2a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14',
  plus: 'M12 5v14M5 12h14', copy: 'M9 9h11v11H9zM5 15H3V3h12v2',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7',
  mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5m-3 6v1a6 6 0 0 0 12 0v-1m-6 7v4m-4 0h8',
  browser: 'M3 4h18v16H3zM3 9h18M7 6h.1M10 6h.1',
  arrow: 'M14 6l-6 6 6 6', refresh: 'M20 11a8 8 0 1 0-2 6M20 4v7h-7',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  check: 'm5 12 4 4 10-10', play: 'm8 4 12 8-12 8z', stop: 'M6 6h12v12H6z',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6M10 15v6', close: 'm6 6 12 12M6 18 18 6'
};
function Icon({ name }: { name: string }) { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name] || iconPaths.sound} /></svg>; }

function Avatar({ data, character, state, previewPose, selected, presence }: {
  data: Bootstrap; character: Character; state: Level & { running: boolean }; previewPose?: AssetPose; selected?: Sprite; presence?: CharacterPresence;
}) {
  const area = useRef<HTMLDivElement>(null);
  const smokeCanvas = useRef<HTMLCanvasElement>(null);
  const geometry = useRef<{ width: number; height: number; bounds?: { left: number; right: number; top: number; bottom: number }; spriteBounds?: Record<string, { left: number; right: number; top: number; bottom: number }> }>({ width: character.width, height: character.height });
  const animator = useRef(createAvatarAnimator());
  const motionAnimator = useRef(createMotionAnimator());
  const images = useRef(new Map<string, HTMLImageElement>());
  const decoded = useRef(new Set<string>());
  const current = useRef({ character, state, previewPose, selected, presence });
  const displayed = useRef<Sprite | undefined>(undefined);
  const [frame, setFrame] = useState<Sprite>();
  const [artworkError, setArtworkError] = useState(false);
  const [fit, setFit] = useState(1);
  const [motion, setMotion] = useState({ offsetX: 0, offsetY: 0, opacity: 1, scale: 1, flipX: false, smoke: 0, visible: true });
  const lastMotion = useRef(motion);
  current.current = { character, state, previewPose, selected, presence };
  useEffect(() => {
    const resize = () => { if (area.current) {
      const nextFit = Math.min(area.current.clientWidth / character.width, area.current.clientHeight / character.height) * .88;
      setFit(nextFit);
      geometry.current = { ...geometry.current, width: area.current.clientWidth / nextFit, height: area.current.clientHeight / nextFit };
    } };
    const observer = new ResizeObserver(resize); if (area.current) observer.observe(area.current); resize();
    return () => observer.disconnect();
  }, [character.width, character.height]);
  useEffect(() => {
    const now = performance.now();
    animator.current.update(character, state, now);
  }, [character, state]);
  useEffect(() => {
    const cache = new Map<string, HTMLImageElement>();
    let canceled = false;
    images.current = cache;
    decoded.current = new Set();
    setArtworkError(false);
    geometry.current.bounds = undefined;
    geometry.current.spriteBounds = {};
    const boundsByFile = new Map<string, { left: number; right: number; top: number; bottom: number }>();
    const recordBounds = (image: HTMLImageElement, item: Sprite) => {
      let bounds = boundsByFile.get(item.file);
      if (!bounds) {
        const surface = document.createElement('canvas'); surface.width = image.naturalWidth; surface.height = image.naturalHeight;
        const context = surface.getContext('2d', { willReadFrequently: true }); if (!context) return;
        context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, surface.width, surface.height).data;
        let left = surface.width, right = -1, top = surface.height, bottom = -1;
        for (let y = 0; y < surface.height; y++) for (let x = 0; x < surface.width; x++) if (pixels[(y * surface.width + x) * 4 + 3]) { left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); }
        if (right < left) return;
        bounds = { left: left - surface.width / 2, right: right + 1 - surface.width / 2, top: top - surface.height / 2, bottom: bottom + 1 - surface.height / 2 };
        boundsByFile.set(item.file, bounds);
      }
      const next = { left: item.x + bounds.left * item.scale, right: item.x + bounds.right * item.scale, top: item.y + bounds.top * item.scale, bottom: item.y + bounds.bottom * item.scale };
      geometry.current.spriteBounds![item.id] = next;
      const previous = geometry.current.bounds;
      geometry.current.bounds = previous ? { left: Math.min(previous.left, next.left), right: Math.max(previous.right, next.right), top: Math.min(previous.top, next.top), bottom: Math.max(previous.bottom, next.bottom) } : next;
    };
    for (const item of allFrames(character)) {
      const url = spriteUrl(data, character.id, item);
      if (cache.has(url)) continue;
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => { void image.decode().catch(() => undefined).then(() => {
        if (canceled || image.naturalWidth < 1) return;
        decoded.current.add(url);
        try { for (const matching of allFrames(character).filter(frame => frame.file === item.file)) recordBounds(image, matching); }
        catch { /* Fall back to canvas extents if pixel measurement is unavailable. */ }
      }); };
      image.onerror = () => { if (!canceled) setArtworkError(true); };
      image.src = url;
      cache.set(url, image);
    }
    return () => { canceled = true; };
  }, [data.overlayOrigin, data.token, character]);
  useEffect(() => {
    animator.current.reset();
    motionAnimator.current.reset();
    animator.current.update(current.current.character, current.current.state, performance.now());
    displayed.current = undefined;
    setFrame(undefined);
  }, [character.id]);
  useEffect(() => {
    let request = 0;
    const tick = (now: number) => {
      const { character: active, previewPose: audition, selected: picked, presence: activePresence } = current.current;
      if (activePresence?.sequence === 0) motionAnimator.current.reset();
      motionAnimator.current.update(active, activePresence, now, geometry.current);
      const travel = motionAnimator.current.frame(now);
      const manual = audition ? poseFrames(active, audition)[0] : undefined;
      const animated = audition ? undefined : animator.current.frame(now);
      const fallbackClosed = audition ? audition === 'closed' || audition === 'A' || audition === 'X' : animator.current.isClosed();
      const fallback = (fallbackClosed ? active.closed[0] : active.open[0]) || active.closed[0] || active.open[0];
      const wanted = (travel.active ? travel.sprite : undefined) || picked || (audition ? manual || fallback : animated) || fallback;
      const ready = (item?: Sprite) => {
        if (!item) return false;
        const image = images.current.get(spriteUrl(data, active.id, item));
        return !!image?.complete && image.naturalWidth > 0 && decoded.current.has(spriteUrl(data, active.id, item));
      };
      const decodedFallback = (fallbackClosed ? [...active.closed, ...active.open] : [...active.open, ...active.closed]).find(ready);
      const next = ready(wanted) ? wanted : decodedFallback;
      if (frameKey(next) !== frameKey(displayed.current)) { displayed.current = next; setFrame(next); }
      const nextMotion = { offsetX: travel.offsetX, offsetY: travel.offsetY, opacity: travel.opacity, scale: travel.scale, flipX: travel.flipX, smoke: travel.smoke, visible: travel.visible };
      if ((Object.keys(nextMotion) as Array<keyof typeof nextMotion>).some(key => nextMotion[key] !== lastMotion.current[key])) {
        lastMotion.current = nextMotion; setMotion(nextMotion);
      }
      const context = smokeCanvas.current?.getContext('2d'); if (context) drawSmokePuff(context, travel.smoke, active.width, active.height);
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [data.overlayOrigin, data.token]);
  return <div className="avatar-space" ref={area}>
    {frame ? <div className="avatar-canvas" style={{ width: character.width, height: character.height, visibility: motion.visible ? 'visible' : 'hidden', transform: `translate(-50%, -50%) scale(${fit})` }}>
      <img src={spriteUrl(data, character.id, frame)} alt={`${character.name}, ${previewPose ? `${previewPose} mouth pose` : state.speaking ? 'speaking' : 'at rest'}`}
        style={{ opacity: motion.opacity, transform: `translate(-50%, -50%) translate(${(motion.flipX ? -frame.x : frame.x) * motion.scale + motion.offsetX}px, ${frame.y * motion.scale + motion.offsetY}px) scale(${frame.scale * motion.scale * (motion.flipX ? -1 : 1)}, ${frame.scale * motion.scale})` }} />
      <canvas className="avatar-smoke" ref={smokeCanvas} width={character.width} height={character.height} aria-hidden="true" />
    </div> : <div className="empty-stage"><Icon name="upload" /><h2>{allFrames(character).length ? artworkError ? 'Artwork could not load' : 'Loading artwork…' : 'Your character starts here'}</h2><p>{artworkError ? 'Reimport the missing image in the builder.' : allFrames(character).length ? 'Preparing the character preview.' : 'Add a closed-mouth image and an open-mouth image in the builder.'}</p></div>}
    {frame && artworkError && <p className="artwork-error" role="status">Some artwork could not load. Check its images in the builder.</p>}
  </div>;
}

export default function App() {
  const [data, setData] = useState<Bootstrap>();
  const [draft, setDraft] = useState<Character>();
  const [settings, setSettings] = useState<AppSettings>();
  const [dirty, setDirty] = useState(false);
  const [editor, setEditor] = useState(false);
  const [creator, setCreator] = useState(false);
  const [presence, setPresence] = useState<CharacterPresence>({ visible: true, sequence: 0 });
  const [view, setView] = useState<'avatar' | 'browser'>('avatar');
  const [pose, setPose] = useState<AssetPose>('closed');
  const [selectedFrame, setSelectedFrame] = useState<string>();
  const [manual, setManual] = useState<'auto' | 'closed' | 'open'>('auto');
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [browser, setBrowser] = useState<BrowserStatus>({ url: '' });
  const [level, setLevel] = useState<Level>(silent);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lipSyncError, setLipSyncError] = useState('');
  const [renaming, setRenaming] = useState<{ id: string; name: string }>();
  const [renameError, setRenameError] = useState('');
  const renameTrigger = useRef<HTMLButtonElement | null>(null);
  const renameInput = useRef<HTMLInputElement | null>(null);
  const engine = useRef<AudioEngine | undefined>(undefined);
  const browserArea = useRef<HTMLDivElement>(null);
  const activeId = useRef('');
  const captureActive = useRef(false);

  useEffect(() => { setPresence({ visible: true, sequence: 0 }); }, [pose]);
  useEffect(() => {
    if (renaming && !busy && renameError) renameInput.current?.focus();
    else if (!renaming && !busy && renameTrigger.current) {
      const trigger = renameTrigger.current; renameTrigger.current = null; trigger.focus();
    }
  }, [renaming, busy, renameError]);

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
    return () => { disposed = true; captureActive.current = false; unsubscribe(); void engine.current?.stop(); };
  }, []);
  useEffect(() => {
    const update = () => {
      const rect = browserArea.current?.getBoundingClientRect();
      window.vox?.browserBounds({ x: rect?.x || 0, y: rect?.y || 0, width: rect?.width || 0, height: rect?.height || 0,
        visible: view === 'browser' && settings?.mode === 'browser' && !editor && !creator && !!rect && rect.top >= 72 && rect.bottom <= window.innerHeight });
    };
    const observer = new ResizeObserver(update); if (browserArea.current) observer.observe(browserArea.current);
    window.addEventListener('resize', update); window.addEventListener('scroll', update, true); update();
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [view, settings?.mode, editor, creator, error, notice]);
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
    captureActive.current = false;
    setRunning(false); setLevel(silent); setLipSyncError(''); setManual('auto');
    if (activeId.current) window.vox?.publish({ characterId: activeId.current, ...silent, running: false });
    await engine.current?.stop(); await window.vox?.browser('stop');
  };
  const changeMode = (mode: AppSettings['mode']) => void perform(async () => {
    if (!settings) return; await stop(); const next = { ...settings, mode }; setSettings(next);
    setData(await window.vox!.saveSettings(next));
    if (mode === 'browser') { setView('browser'); if (!browser.url) await window.vox!.browser('navigate', next.assistantUrl); }
    else setView('avatar');
  });
  const patchCharacter = (patch: Partial<Character>) => { setDraft(current => current && { ...current, ...patch }); setDirty(true); };
  const discardDraft = async () => {
    if (draft && data && !data.characters.some(character => character.id === draft.id)) await window.vox!.discardCharacterDraft(draft.id);
  };
  const replacePose = (frames: Sprite[]) => {
    if (!draft) return;
    if (pose === 'enter' || pose === 'exit') {
      const motions = { ...draft.motions };
      if (frames.length) motions[pose] = { frameMs: 120, durationMs: 1800, side: pose === 'exit' ? motions.enter?.side || 'right' : 'right', facing: 'right', ...motions[pose], frames };
      else if (motions[pose]?.effect && motions[pose]?.effect !== 'walk') motions[pose] = { ...motions[pose]!, frames: [] };
      else delete motions[pose];
      patchCharacter({ motions });
    } else if (pose === 'closed' || pose === 'open') patchCharacter({ [pose]: frames });
    else {
      const visemes = { ...draft.visemes };
      if (frames.length) visemes[pose] = frames; else delete visemes[pose];
      patchCharacter({ visemes });
    }
  };
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
  const cancelRename = () => { setRenaming(undefined); setRenameError(''); };
  const renameCharacter = async () => {
    if (!renaming || busy) return;
    const name = renaming.name.trim();
    if (!name) { setRenameError('Enter a character name.'); return; }
    setBusy(true); setRenameError(''); setError(''); setNotice('');
    try {
      const updated = await window.vox!.renameCharacter(renaming.id, name);
      const renamed = updated.characters.find(character => character.id === renaming.id)!;
      setData(updated);
      setDraft(current => current?.id === renamed.id ? { ...current, name: renamed.name } : current);
      setRenaming(undefined); setNotice(`Character renamed to “${renamed.name}”.`);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : 'The name could not be saved. Try again.');
    } finally { setBusy(false); }
  };
  const choose = (character: Character) => void perform(async () => {
    if (dirty && !window.confirm('Discard your unsaved character or settings changes?')) return;
    await discardDraft();
    await stop(); setDraft(structuredClone(character)); setDirty(false); setSelectedFrame(undefined); setPose('closed'); setManual('auto'); setCreator(false); setPresence({ visible: true, sequence: 0 });
    activeId.current = character.id;
    if (data) { const next = { ...data.settings, activeCharacterId: character.id }; setSettings(next); engine.current?.setSettings(next.detector); setData(await window.vox!.saveSettings(next)); }
  });
  const deleteCharacter = (character: Character) => void perform(async () => {
    if (!data || data.characters.length <= 1) return;
    const selected = draft?.id === character.id;
    const message = `Delete “${character.name}”? This permanently removes the character and its saved artwork from this computer. Its OBS source will stop displaying it.${selected && dirty ? ' Your unsaved character and settings changes will also be discarded.' : ''}\n\nThis cannot be undone.`;
    if (!window.confirm(message)) return;
    cancelRename();
    if (selected || activeId.current === character.id) await stop();
    const updated = await window.vox!.deleteCharacter(character.id);
    setData(updated); activeId.current = updated.settings.activeCharacterId;
    if (selected) {
      const replacement = updated.characters.find(item => item.id === updated.settings.activeCharacterId)!;
      setDraft(structuredClone(replacement)); setSettings(updated.settings); engine.current?.setSettings(updated.settings.detector);
      setDirty(false); setEditor(false); setCreator(false); setView('avatar'); setSelectedFrame(undefined); setPose('closed'); setManual('auto'); setPresence({ visible: true, sequence: 0 });
    } else {
      setSettings(current => current && { ...current, activeCharacterId: updated.settings.activeCharacterId });
    }
    setNotice(`“${character.name}” deleted.`);
  });
  const create = () => void perform(async () => {
    if (dirty && !window.confirm('Discard your unsaved character or settings changes?')) return;
    await discardDraft();
    await stop();
    if (data) { setSettings(structuredClone(data.settings)); engine.current?.setSettings(data.settings.detector); }
    setDraft({ id: crypto.randomUUID(), name: 'New character', width: 600, height: 600, closed: [], open: [], frameMs: 180, animationMode: 'binary' });
    setDirty(true); setEditor(true); setCreator(true); setView('avatar'); setSelectedFrame(undefined); setPose('closed'); setManual('auto'); setPresence({ visible: true, sequence: 0 });
  });
  const tryDemo = () => void perform(async () => {
    if (dirty && !window.confirm('Discard your unsaved character or settings changes?')) return;
    await discardDraft();
    await stop();
    const updated = await window.vox!.createVisemeDemo();
    const character = updated.characters.find(c => c.id === updated.settings.activeCharacterId);
    if (!character) throw new Error('The lip-sync demo could not be opened. Try again.');
    setData(updated); setSettings(updated.settings); setDraft(structuredClone(character)); activeId.current = character.id;
    engine.current?.setSettings(updated.settings.detector);
    setDirty(false); setEditor(true); setCreator(false); setView('avatar'); setPose('X'); setSelectedFrame(undefined); setManual('auto'); setPresence({ visible: true, sequence: 0 });
    setNotice('Demo ready. Select a mouth pose below to preview it, or close the builder and start audio.');
  });
  const addImages = () => void perform(async () => {
    if (!draft) return; const imported = await window.vox!.importImages(draft.id, pose);
    if (imported.length) { replacePose([...poseFrames(draft, pose), ...imported]); setSelectedFrame(imported[0].id); }
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
    activeId.current = draft.id; setManual('auto'); setLipSyncError(''); captureActive.current = true;
    const onLevel = (value: Level) => {
      if (!captureActive.current) return;
      setLevel(value); setLipSyncError(value.lipSyncError || '');
      window.vox!.publish({ characterId: activeId.current, level: value.level, db: value.db, speaking: value.speaking, ...(value.articulation ? { articulation: value.articulation } : {}), running: true });
    };
    const ended = (message?: string) => { captureActive.current = false; setRunning(false); setLevel(silent); setLipSyncError(''); if (message) setError(message);
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
    replacePose(poseFrames(draft, pose).map(f => f.id === selectedFrame ? { ...f, ...patch } : f));
  };
  const previewMotion = (visible: boolean) => { setPresence(previous => ({ visible, sequence: previous.sequence + 1 })); setSelectedFrame(undefined); setView('avatar'); };
  const setEffect = (kind: 'enter' | 'exit', value: string) => {
    if (!draft) return;
    const motions = { ...draft.motions };
    if (value === 'none') delete motions[kind];
    else motions[kind] = { frames: [], frameMs: 120, durationMs: value === 'walk' ? 1800 : 1000,
      side: kind === 'exit' ? motions.enter?.side || 'right' : 'right', facing: 'right', ...motions[kind], effect: value as MotionEffect };
    patchCharacter({ motions }); setPresence({ visible: true, sequence: 0 });
  };

  if (!data || !draft || !settings) return <main className="loading-screen"><Icon name="sound" /><h1>Voxincarnate</h1><p role={error ? 'alert' : 'status'}>{error || 'Opening your studio…'}</p></main>;
  const inputList = settings.mode === 'browser' ? browser.devices || [] : devices;
  const inputId = settings.mode === 'browser' ? settings.browserInputId : settings.inputId;
  const frames = poseFrames(draft, pose);
  const picked = frames.find(f => f.id === selectedFrame);
  const motionPose = pose === 'enter' || pose === 'exit';
  const selectedClip = motionPose ? draft.motions?.[pose] : undefined;
  const invalidMotion = (['enter', 'exit'] as const).some(kind => { const clip = draft.motions?.[kind]; return clip && (!clip.effect || clip.effect === 'walk') && !clip.frames.length; });
  const speaking = manual === 'auto' ? level.speaking : manual === 'open';
  const visemeMode = draft.animationMode === 'viseme';
  const completePoses = VISEMES.filter(p => draft.visemes?.[p]?.length).length;
  const previewPose = editor ? pose : manual === 'auto' ? undefined : manual;
  const previewState = manual === 'auto' ? { ...level, running } : { ...silent, running: true, speaking: manual === 'open' };
  const isNew = !data.characters.some(c => c.id === draft.id);
  return <div className="studio" data-ready="true">
    <header className="topbar">
      <div className="wordmark"><span className="brand-icon"><Icon name="sound" /></span><strong>Voxincarnate</strong><span className="app-version">STUDIO</span></div>
      <div className="session-status"><span className={`status-dot ${running ? 'live' : ''}`} />{running ? 'Audio active' : 'Ready when you are'}</div>
      <span className="save-state">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <button className="primary save-button" disabled={busy || creator || !dirty || !draft.closed.length || !draft.open.length || invalidMotion} onClick={save}><Icon name="check" />Save changes</button>
    </header>
    <aside className="library">
      <div className="section-title"><h2>Characters</h2><span>{data.characters.length}</span></div>
      <button className="add-character" onClick={create} disabled={busy || running}><Icon name="plus" />New character</button>
      <button className="demo-character text-button" onClick={tryDemo} disabled={busy || running}>Try lip-sync demo</button>
      <nav aria-label="Character library">{data.characters.map(character => <div className="character-row" key={character.id}><button className={`character-item ${draft.id === character.id ? 'selected' : ''}`} onClick={() => choose(character)} disabled={busy}>
        <span className="character-thumb">{character.closed[0] && <img src={spriteUrl(data, character.id, character.closed[0])} alt="" />}</span>
        <span><strong>{character.name}</strong><small>{allFrames(character).length} images</small></span>
      </button><div className="character-actions"><button className="rename-character" aria-label={`Rename ${character.name}`} title={`Rename ${character.name}`} aria-expanded={renaming?.id === character.id} aria-controls={renaming?.id === character.id ? `rename-${character.id}` : undefined} disabled={busy || creator} onClick={event => { renameTrigger.current = event.currentTarget; setRenaming({ id: character.id, name: character.name }); setRenameError(''); }}><Icon name="pencil" /></button><button className="delete-character" aria-label={`Delete ${character.name}`} title={data.characters.length <= 1 ? 'Add another character before deleting this one' : `Delete ${character.name}`} disabled={busy || creator || data.characters.length <= 1} onClick={() => deleteCharacter(character)}><Icon name="trash" /></button></div>
      {renaming?.id === character.id && <form className="character-rename" id={`rename-${character.id}`} onSubmit={event => { event.preventDefault(); void renameCharacter(); }} onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); cancelRename(); } }}>
        <label htmlFor={`character-name-${character.id}`}>Character name</label><input ref={renameInput} id={`character-name-${character.id}`} value={renaming.name} maxLength={120} required autoFocus onFocus={event => event.currentTarget.select()} disabled={busy} aria-invalid={!!renameError} aria-describedby={renameError ? `rename-error-${character.id}` : undefined} onChange={event => { setRenaming({ id: character.id, name: event.target.value }); setRenameError(''); }} />
        {renameError && <p className="rename-error" id={`rename-error-${character.id}`} role="alert">{renameError}</p>}
        <div className="rename-actions"><button type="submit" className="primary" disabled={busy || !renaming.name.trim()}>Save name</button><button type="button" className="secondary" disabled={busy} onClick={cancelRename}>Cancel</button></div>
      </form>}</div>)}</nav>
      {data.characters.length === 1 && <p className="library-help">Keep at least one character. Add another to delete this one.</p>}
      <div className="library-note"><Icon name="sound" /><p>A little character.<br />A voice of its own.</p></div>
      <p className="local-note">Artwork is saved on this computer. AI generation uses OpenAI.</p>
    </aside>
    <main className="main-area">
      <div className="character-heading"><div><h1>{draft.name}</h1><p>{editor ? 'Build a character that feels like you.' : 'Your character, ready for the conversation.'}</p></div>
        <button className={editor ? 'secondary active' : 'secondary'} onClick={() => { setEditor(!editor); setCreator(false); setView('avatar'); setSelectedFrame(undefined); }} disabled={running || busy}><Icon name="settings" />{editor ? 'Close builder' : 'Edit character'}</button></div>
      {(error || notice) && <div className={`message ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error || notice}</span><button aria-label="Dismiss message" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" /></button></div>}
      {creator && <CharacterCreator onClose={() => setCreator(false)} onManual={() => setCreator(false)} onWorking={setBusy} onCreated={async character => {
        await discardDraft();
        setDraft(character); setDirty(true); setCreator(false); setEditor(true); setPose('X'); setSelectedFrame(undefined); setPresence({ visible: true, sequence: 0 });
        setNotice('Character kit ready for review. Preview all nine mouth shapes, the entrance, and the exit, then save.');
      }} />}
      <div className={`workspace${editor ? ' editing' : ''}${creator ? ' creator-background' : ''}`}>
        <div className="character-workspace">
          <section className="stage-panel" aria-label="Character preview">
            <div className="stage-toolbar"><div className="tabs"><button className={view === 'avatar' ? 'active' : ''} onClick={() => setView('avatar')}>Avatar preview</button>
              {settings.mode === 'browser' && !editor && <button className={view === 'browser' ? 'active' : ''} onClick={() => setView('browser')}>Assistant browser</button>}</div>
              <span className="canvas-size">{draft.width} × {draft.height}</span></div>
            <div className={`stage ${view === 'browser' && !editor ? 'with-browser' : ''}`}>
              <Avatar data={data} character={draft} state={previewState} previewPose={previewPose} selected={editor ? picked : undefined} presence={presence} />
              <div ref={browserArea} className="browser-area" aria-label="Embedded assistant browser" hidden={view !== 'browser' || editor} />
              {view === 'avatar' && <div className="stage-label"><span className={`status-dot ${!editor && speaking ? 'live' : ''}`} />{editor ? `${pose} · ${frames.length ? 'Pose preview' : 'Fallback preview'}` : speaking ? 'Speaking' : 'Idle'}<span>Transparent canvas</span></div>}
            </div>
            <div className="preview-controls"><span>Preview mouth</span><div className="segmented">{(['auto', 'closed', 'open'] as const).map(value => <button key={value} className={manual === value ? 'active' : ''} onClick={() => setManual(value)} disabled={editor}>{value === 'auto' ? 'Audio' : value === 'closed' ? 'Closed' : 'Open'}</button>)}</div><span className="preview-note">Preview controls stay out of OBS</span></div>
            {(draft.motions?.enter || draft.motions?.exit) && <div className="walk-preview"><span>Preview entrance / exit</span><button className="secondary" disabled={!draft.motions?.enter || ((!draft.motions.enter.effect || draft.motions.enter.effect === 'walk') && !draft.motions.enter.frames.length)} onClick={() => previewMotion(true)}>{draft.motions?.enter?.effect && draft.motions.enter.effect !== 'walk' ? 'Preview entrance' : 'Walk in'}</button><button className="secondary" disabled={!draft.motions?.exit || ((!draft.motions.exit.effect || draft.motions.exit.effect === 'walk') && !draft.motions.exit.frames.length)} onClick={() => previewMotion(false)}>{draft.motions?.exit?.effect && draft.motions.exit.effect !== 'walk' ? 'Preview exit' : 'Walk out'}</button><span className="helper">Local preview</span></div>}
          </section>
          {editor && !creator && <section className="builder"><div className="builder-header"><h2>Character builder</h2><span>Keep a closed and open image for fallback</span><button className="text-button" disabled={busy} onClick={() => { if (allFrames(draft).length && !window.confirm('Generate a new character kit? Your current draft stays here until generation succeeds.')) return; setCreator(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Create from an image or idea</button></div>
            <div className="character-fields"><label>Name<input value={draft.name} maxLength={120} onChange={e => patchCharacter({ name: e.target.value })} /></label><label>Canvas width<input type="number" min="64" max="4096" value={draft.width} onChange={e => patchCharacter({ width: Number(e.target.value) })} /></label><label>Canvas height<input type="number" min="64" max="4096" value={draft.height} onChange={e => patchCharacter({ height: Number(e.target.value) })} /></label><label>Frame interval (ms)<input type="number" min="60" max="5000" value={draft.frameMs} onChange={e => patchCharacter({ frameMs: Number(e.target.value) })} /></label></div>
            <div className="animation-setting"><label htmlFor="animation-mode">Mouth animation<select id="animation-mode" value={visemeMode ? 'viseme' : 'binary'} onChange={e => { const mode = e.target.value === 'viseme' ? 'viseme' : 'binary'; patchCharacter({ animationMode: mode }); setPose(mode === 'viseme' ? 'X' : 'closed'); setSelectedFrame(undefined); }}><option value="binary">Closed / open</option><option value="viseme">Lip sync · nine mouth poses</option></select></label><p className="helper">{visemeMode ? 'Add distinct mouth shapes for speech sounds. Your existing closed/open images remain available for missing poses.' : 'Use audio volume to switch between closed and open artwork. Lip sync lets you add mouth shapes for individual sounds.'}</p></div>
            <div className="entrance-settings"><h3>Entrance and exit</h3><div className="entrance-options">{(['enter', 'exit'] as const).map(kind => {
              const clip = draft.motions?.[kind];
              return <div key={kind}><label htmlFor={`motion-effect-${kind}`}>{kind === 'enter' ? 'Entrance animation' : 'Exit animation'}<select id={`motion-effect-${kind}`} value={clip ? clip.effect || 'walk' : 'none'} onChange={event => setEffect(kind, event.target.value)}><option value="none">No animation</option><option value="walk">Walk {kind === 'enter' ? 'in from an edge' : 'out through an edge'}</option><option value="smoke">{kind === 'enter' ? 'Appear' : 'Disappear'} in smoke</option><option value="fall-jump">{kind === 'enter' ? 'Fall from the top' : 'Jump out through the top'}</option></select></label>
                {clip && <div className="entrance-timing"><label>{kind === 'enter' ? 'Enter from' : 'Exit toward'}<select value={clip.side} disabled={clip.effect === 'smoke' || clip.effect === 'fall-jump'} onChange={event => patchCharacter({ motions: { ...draft.motions, [kind]: { ...clip, side: event.target.value as 'left' | 'right' } } })}><option value="right">Right edge · {kind === 'enter' ? 'moves left' : 'moves right'}</option><option value="left">Left edge · {kind === 'enter' ? 'moves right' : 'moves left'}</option></select></label><label>Duration (ms)<input type="number" min="200" max="20000" step="100" value={clip.durationMs} onChange={event => patchCharacter({ motions: { ...draft.motions, [kind]: { ...clip, durationMs: Number(event.target.value) } } })} /></label></div>}
              </div>;
            })}</div><p className="helper">Walks begin just beyond the visible frame edge. Smoke and fall/jump use the original resting artwork and need no new images.</p>{invalidMotion && <p className="inline-error" role="status">Add walking frames in the artwork picker before saving, or choose smoke or fall/jump.</p>}</div>
            {visemeMode && <div className="pose-completeness"><div className="label-row"><strong>Mouth poses</strong><span>{completePoses}/9 added{completePoses < 9 ? ' · Missing poses use fallback artwork' : ' · All poses ready'}</span></div><div className="pose-status">{VISEMES.map(p => <button key={p} className={`${pose === p ? 'active ' : ''}${draft.visemes?.[p]?.length ? 'complete' : ''}`} onClick={() => { setPose(p); setSelectedFrame(undefined); }} aria-pressed={pose === p} title={`${VISEME_LABELS[p]} · ${draft.visemes?.[p]?.length || 0} images`}><b>{p}</b><span>{VISEME_LABELS[p]}</span><small>{draft.visemes?.[p]?.length ? 'Added' : 'Missing'}</small></button>)}</div></div>}
            <div className="builder-tools"><label className="pose-picker" htmlFor="mouth-pose">Preview and edit artwork<select id="mouth-pose" value={pose} onChange={e => { setPose(e.target.value as AssetPose); setSelectedFrame(undefined); setPresence({ visible: true, sequence: 0 }); }}>
              {visemeMode && <optgroup label="Lip-sync mouth poses">{VISEMES.map(p => <option key={p} value={p}>{p} · {VISEME_LABELS[p]} ({draft.visemes?.[p]?.length || 0})</option>)}</optgroup>}
              <optgroup label="Fallback artwork"><option value="closed">Closed mouth ({draft.closed.length})</option><option value="open">Open mouth ({draft.open.length})</option></optgroup>
              <optgroup label="Walking animations"><option value="enter">Walk into frame ({draft.motions?.enter?.frames.length || 0})</option><option value="exit">Walk out of frame ({draft.motions?.exit?.frames.length || 0})</option></optgroup>
            </select></label><button className="secondary" onClick={addImages} disabled={busy}><Icon name="upload" />Add {motionPose ? 'walking frames' : 'images'}</button></div>
            {motionPose ? <p className="pose-guide">Frames play in order as a repeating walking cycle. Preview the complete path above. Use matching full-body artwork with a consistent scale and foot baseline.</p> : visemeMode && <p className="pose-guide">Selecting a pose previews it above. Use the same canvas and keep the character, background, and upper teeth aligned. Pose C provides the intermediate shape between closed lips and a wide-open D.</p>}
            {motionPose && selectedClip && (!selectedClip.effect || selectedClip.effect === 'walk') && <div className="motion-settings">
              <label>Path duration (ms)<input type="number" min="200" max="20000" step="100" value={selectedClip.durationMs} onChange={e => patchCharacter({ motions: { ...draft.motions, [pose]: { ...selectedClip, durationMs: Number(e.target.value) } } })} /></label>
              <label>Walking frame interval (ms)<input type="number" min="40" max="10000" step="10" value={selectedClip.frameMs} onChange={e => patchCharacter({ motions: { ...draft.motions, [pose]: { ...selectedClip, frameMs: Number(e.target.value) } } })} /></label>
              <label>{pose === 'enter' ? 'Enter from' : 'Exit toward'}<select value={selectedClip.side} onChange={e => patchCharacter({ motions: { ...draft.motions, [pose]: { ...selectedClip, side: e.target.value as 'left' | 'right' } } })}><option value="left">Left edge</option><option value="right">Right edge</option></select></label>
              {(!selectedClip.effect || selectedClip.effect === 'walk') && <label>Walking artwork faces<select value={selectedClip.facing || 'right'} onChange={e => patchCharacter({ motions: { ...draft.motions, [pose]: { ...selectedClip, facing: e.target.value as 'left' | 'right' } } })}><option value="right">Right</option><option value="left">Left</option></select></label>}
              <button className="secondary" onClick={() => previewMotion(pose === 'enter')}>Preview {pose === 'enter' ? 'walk-in' : 'walk-out'}</button>
            </div>}
            <div className="frame-list">{frames.map((frame, index) => <div className={`frame ${frame.id === selectedFrame ? 'selected' : ''}`} key={frame.id}><button className="frame-select" onClick={() => setSelectedFrame(frame.id)}><img src={spriteUrl(data, draft.id, frame)} alt={frame.name} /><span>{index === 0 ? 'Default · ' : ''}{frame.name}</span></button><div className="frame-actions"><button disabled={index === 0} onClick={() => { const list = [...frames]; [list[index - 1], list[index]] = [list[index], list[index - 1]]; replacePose(list); }}>Move earlier</button><button onClick={() => { replacePose(frames.filter(f => f.id !== frame.id)); if (selectedFrame === frame.id) setSelectedFrame(undefined); }}>Remove</button></div></div>)}{!frames.length && <p className="empty-frames">{visemeMode && pose !== 'closed' && pose !== 'open' ? `${pose} has no artwork yet; the preview uses a fallback. ` : ''}Add PNG or JPEG images for this pose. Transparent PNGs work best for OBS.</p>}</div>
            {picked && <div className="alignment"><strong>Align {picked.name}</strong><label>Horizontal offset<input type="number" min="-4096" max="4096" value={picked.x} onChange={e => updateSprite({ x: Number(e.target.value) })} /></label><label>Vertical offset<input type="number" min="-4096" max="4096" value={picked.y} onChange={e => updateSprite({ y: Number(e.target.value) })} /></label><label>Scale<input type="range" min="0.1" max="4" step="0.05" value={picked.scale} onChange={e => updateSprite({ scale: Number(e.target.value) })} /></label><button className="text-button" onClick={() => updateSprite({ x: 0, y: 0, scale: 1 })}>Reset alignment</button></div>}
          </section>}
        </div>
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
            {visemeMode && <p className="helper">Lip sync runs locally on this computer. {completePoses}/9 mouth poses available.</p>}
            {lipSyncError && visemeMode && <p className="inline-error" role="status">{lipSyncError} Using closed/open animation. Stop audio and start again to retry.</p>}
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
            {(draft.motions?.enter || draft.motions?.exit) && <div className="obs-presence"><h3>On-air entrance / exit</h3><div><button className="secondary" disabled={isNew || dirty || busy} onClick={() => void perform(async () => { const next = await window.vox!.setCharacterPresence(draft.id, true); setPresence(previous => ({ ...next, sequence: previous.sequence + 1 })); setNotice('Entrance sent to OBS.'); })}>Enter OBS</button><button className="secondary" disabled={isNew || dirty || busy} onClick={() => void perform(async () => { const next = await window.vox!.setCharacterPresence(draft.id, false); setPresence(previous => ({ ...next, sequence: previous.sequence + 1 })); setNotice('Exit sent to OBS.'); })}>Exit OBS</button></div><p className="helper">These buttons control the saved character in OBS. An exit keeps it hidden until the next entrance.</p></div>}
          </section>
        </aside>
      </div>
      <footer className="studio-footer"><span><span className={`status-dot ${running ? 'live' : ''}`} />{running ? 'Sending animation to OBS' : 'OBS overlay available'}</span><span>Voxincarnate {appVersion} · Windows desktop</span></footer>
    </main>
  </div>;
}
