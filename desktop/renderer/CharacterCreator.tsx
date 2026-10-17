import { useEffect, useRef, useState } from 'react';
import type { Character, CharacterSource, GenerationAvailability, GenerationProgress, MotionEffect, NormalizedRegion } from '../shared';
import { MouthRegionEditor } from './MouthRegionEditor';

export function CharacterCreator({ onCreated, onManual, onClose, onWorking }: {
  onCreated(character: Character): void | Promise<void>; onManual(): void; onClose(): void; onWorking(working: boolean): void;
}) {
  const [mode, setMode] = useState<'image' | 'idea'>('image');
  const [source, setSource] = useState<CharacterSource>();
  const [name, setName] = useState('New character');
  const [description, setDescription] = useState('');
  const [style, setStyle] = useState('');
  const [mouthRegion, setMouthRegion] = useState<NormalizedRegion>();
  const [faceRegion, setFaceRegion] = useState<NormalizedRegion>();
  const [speechMode, setSpeechMode] = useState<'mouth' | 'face'>('mouth');
  const [detected, setDetected] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [selectionError, setSelectionError] = useState('');
  const [entranceSide, setEntranceSide] = useState<'left' | 'right'>('right');
  const [exitSide, setExitSide] = useState<'left' | 'right'>('right');
  const [sameEdge, setSameEdge] = useState(true);
  const [entranceEffect, setEntranceEffect] = useState<MotionEffect>('walk');
  const [exitEffect, setExitEffect] = useState<MotionEffect>('walk');
  const [availability, setAvailability] = useState<GenerationAvailability>();
  const [working, setWorking] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress>();
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
    void window.vox!.generationAvailability().then(setAvailability).catch(() => setError('Generation status could not be checked. Close this panel and try again.'));
    return window.vox!.onGenerationProgress(setProgress);
  }, []);
  const chooseImage = async () => {
    setChoosing(true); setError('');
    try { const image = await window.vox!.chooseCharacterSource(); if (image) { setSource(image); setMouthRegion(undefined); setFaceRegion(undefined); setDetected(false); setSelectionError(''); } }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setChoosing(false); }
  };
  const detectFace = async () => {
    if (!source) return;
    setDetecting(true); onWorking(true); setError(''); setSelectionError(''); setCancelling(false);
    try {
      const selection = await window.vox!.detectCharacterFace(source.id);
      setFaceRegion(selection.faceRegion); setMouthRegion(selection.mouthRegion); setDetected(true);
    } catch (error) { setSelectionError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setDetecting(false); onWorking(false); setCancelling(false); }
  };
  const generate = async () => {
    setWorking(true); onWorking(true); setError(''); setCancelling(false); setProgress(undefined);
    try {
      const character = await window.vox!.generateCharacter({ name, speechMode, ...(mode === 'image' ? { sourceId: source?.id, mouthRegion, faceRegion: faceContainsMouth ? faceRegion : undefined } : { description }), style,
        entranceSide, exitSide: sameEdge ? entranceSide : exitSide, entranceEffect, exitEffect });
      await onCreated(character);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setWorking(false); onWorking(false); }
  };
  const cancel = async () => {
    setCancelling(true);
    try { await window.vox!.cancelGeneration(); }
    catch { setError('Could not cancel the request. Wait for generation to finish.'); setCancelling(false); }
  };
  const faceContainsMouth = !!faceRegion && !!mouthRegion && mouthRegion.x >= faceRegion.x && mouthRegion.y >= faceRegion.y &&
    mouthRegion.x + mouthRegion.width <= faceRegion.x + faceRegion.width + .000001 && mouthRegion.y + mouthRegion.height <= faceRegion.y + faceRegion.height + .000001;
  const valid = name.trim() && (mode === 'image' ? source && mouthRegion && mouthRegion.width * mouthRegion.height <= .25 &&
    (speechMode === 'mouth' || faceContainsMouth && faceRegion!.width * faceRegion!.height <= .65) : description.trim());
  const busy = working || detecting;
  return <section className="character-creator" aria-labelledby="creator-title" aria-busy={busy}>
    <div className="creator-heading"><div><h2 id="creator-title" tabIndex={-1} ref={title}>Create a complete character</h2><p>One reference. A voice, an entrance, and an exit.</p></div>
      <button className="secondary" onClick={onClose} disabled={busy || choosing}>Close</button></div>
    <div className="creator-layout">
      <div className="creator-input">
        <div className="tabs creator-tabs" role="group" aria-label="Character source">
          <button aria-pressed={mode === 'image'} className={mode === 'image' ? 'active' : ''} disabled={busy || choosing} onClick={() => { setMode('image'); setError(''); }}>Use an image</button>
          <button aria-pressed={mode === 'idea'} className={mode === 'idea' ? 'active' : ''} disabled={busy || choosing} onClick={() => { setMode('idea'); setError(''); }}>Generate a character</button>
        </div>
        {mode === 'image' ? <>
          <button className={`reference-picker ${source ? 'has-reference' : ''}`} onClick={() => void chooseImage()} disabled={busy || choosing}>
            {source ? <><img src={source.previewUrl} alt="Selected character reference" /><span><strong>{source.name}</strong><small>{source.width} × {source.height} · Change image</small></span></> : <><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" /></svg><strong>{choosing ? 'Opening image picker…' : 'Choose a character image'}</strong><small>PNG or JPEG · Up to 16 MB / 4096 px</small></>}
          </button><p className="helper">Locate and review the face before creating speech artwork. Everything outside the selected speech area stays fixed.</p>
          {source && <MouthRegionEditor source={source} region={mouthRegion} faceRegion={faceRegion} detected={detected} detecting={detecting} error={selectionError}
            onDetect={() => void detectFace()} canDetect={!!availability?.available} onChange={region => { setMouthRegion(region); setDetected(false); setSelectionError(''); }}
            onFaceChange={region => { setFaceRegion(region); setDetected(false); setSelectionError(''); }} disabled={busy || choosing} />}
        </> : <label htmlFor="creator-description">Describe your character<textarea id="creator-description" value={description} onChange={e => setDescription(e.target.value)} disabled={busy} maxLength={4000} rows={5} placeholder="A friendly copper robot with an expressive face, round glasses, and worn canvas sneakers…" /><span className="helper">OpenAI develops the concept and generates a reference, then creates the animation artwork.</span></label>}
        <div className="creator-fields"><label htmlFor="creator-name">Character name<input id="creator-name" value={name} onChange={e => setName(e.target.value)} disabled={busy} maxLength={120} /></label>
          <label htmlFor="creator-style">Style and details <span className="optional">optional</span><textarea id="creator-style" value={style} onChange={e => setStyle(e.target.value)} disabled={busy} maxLength={4000} rows={2} placeholder="Keep the original style, outfit, and proportions." /></label></div>
      </div>
      <div className="creator-output"><h3>Your character kit</h3>
        <ul className="kit-list"><li><strong>Speech animation</strong><span>Nine speech poses with soft edges and matched facial colors. Body texture stays fixed.</span></li><li><strong>Entrance and exit</strong><span>Walk from an edge, appear in smoke, or fall in and jump out.</span></li></ul>
        <fieldset className="creator-speech" disabled={busy}><legend>Speech style</legend>
          <label htmlFor="creator-speech-mode">Animate<select id="creator-speech-mode" value={speechMode} onChange={event => setSpeechMode(event.target.value as 'mouth' | 'face')}><option value="mouth">Mouth with a soft blend</option><option value="face">Natural face expressions</option></select></label>
          <p className="helper">{speechMode === 'mouth' ? 'Moves the lips and jaw with surrounding facial context for a smoother blend.' : 'Adds subtle cheek and brow expressions inside the selected face area. Everything outside that area stays fixed.'}</p>
          {mode === 'image' && speechMode === 'face' && !faceContainsMouth && <p className="inline-error" role="status">Select a face area that contains the mouth before generating.</p>}
        </fieldset>
        <fieldset className="creator-motion" disabled={busy}><legend>Entrance and exit</legend>
          <label htmlFor="creator-entrance-effect">Entrance<select id="creator-entrance-effect" value={entranceEffect} onChange={event => setEntranceEffect(event.target.value as MotionEffect)}><option value="walk">Walk into frame</option><option value="smoke">Appear in a puff of smoke</option><option value="fall-jump">Fall from the top</option></select></label>
          <label htmlFor="creator-exit-effect">Exit<select id="creator-exit-effect" value={exitEffect} onChange={event => setExitEffect(event.target.value as MotionEffect)}><option value="walk">Walk out of frame</option><option value="smoke">Disappear in a puff of smoke</option><option value="fall-jump">Jump out through the top</option></select></label>
          <label htmlFor="creator-entrance-side">Enter from<select id="creator-entrance-side" value={entranceSide} disabled={entranceEffect !== 'walk'} onChange={event => setEntranceSide(event.target.value as 'left' | 'right')}><option value="right">Right edge · moves left</option><option value="left">Left edge · moves right</option></select></label>
          <label className="same-edge"><input type="checkbox" checked={sameEdge} onChange={event => { setSameEdge(event.target.checked); setExitSide(entranceSide); }} />Exit through the same edge</label>
          {!sameEdge && <label htmlFor="creator-exit-side">Exit toward<select id="creator-exit-side" value={exitSide} disabled={exitEffect !== 'walk'} onChange={event => setExitSide(event.target.value as 'left' | 'right')}><option value="right">Right edge · moves right</option><option value="left">Left edge · moves left</option></select></label>}
          <p className="helper">{sameEdge ? `Walks enter from the ${entranceSide} and return to that edge. ` : ''}Walking starts just outside the visible frame. Smoke and fall/jump effects use the original artwork.</p>
        </fieldset>
        <p className="helper">Review every pose and play both clips in the builder. Adjust timing, alignment, and direction before saving.</p>
        <div className="generation-disclosure"><strong>Uses OpenAI · API charges apply</strong><p>{mode === 'image' ? 'Your reference and style notes are sent to OpenAI. Find face automatically uses a separate vision request; review its selection before generating.' : 'OpenAI creates a reference and locates its face before generating animation artwork.'} Speech edits are blended locally inside the selected area. Walking artwork can still need review. Generation can take several minutes.</p></div>
        {availability && !availability.available && <p className="inline-error" role="status">OpenAI is unavailable. Set OPENAI_API_KEY in the app’s launch environment and restart. Manual creation is available below.</p>}
        {busy && <div className="generation-progress" role="status" aria-live="polite"><strong>{cancelling ? 'Cancelling…' : detecting ? 'Finding the face and mouth…' : progress?.stage || 'Starting generation…'}</strong>{!detecting && <progress max={progress?.total || 1} value={progress?.completed || 0} aria-label="Character generation progress" />}<p>{detecting ? 'Check that the face and mouth boxes cover the character when detection finishes.' : 'Keep the app open. Cancel stops remaining steps; requests already sent may still be billed.'}</p></div>}
        {error && <p className="inline-error" role="alert">{error.replace(/^Error invoking remote method '[^']+': Error: /, '')}</p>}
        {mode === 'image' && source && !mouthRegion && !detecting && <p className="helper">Find the face automatically or choose the mouth area to enable generation.</p>}
        <div className="creator-actions"><button className="primary" id="generate-character" onClick={() => void generate()} disabled={!availability?.available || !valid || busy || choosing}>{working ? 'Generating character…' : 'Generate character kit'}</button>
          {busy && <button className="secondary" onClick={() => void cancel()} disabled={cancelling}>{detecting ? 'Cancel detection' : 'Cancel generation'}</button>}</div>
        <button className="text-button manual-creation" disabled={busy || choosing} onClick={onManual}>Build manually with your own artwork</button>
      </div>
    </div>
  </section>;
}
