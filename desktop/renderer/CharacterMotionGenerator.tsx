import { useEffect, useState } from 'react';
import { MOTION_EFFECTS, MOTION_KINDS, type Character, type GenerationAvailability, type GenerationProgress, type MotionSelection as Selection } from '../shared';
import { hasMotion } from '../character-motions';
import { MotionSelection } from './MotionSelection';

export function CharacterMotionGenerator({ character, busy, onWorking, onAdded }: {
  character: Character; busy: boolean; onWorking(working: boolean): void; onAdded(character: Character): void;
}) {
  const [selection, setSelection] = useState<Selection>({ enter: [], exit: [] });
  const [availability, setAvailability] = useState<GenerationAvailability>();
  const [working, setWorking] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<GenerationProgress>();
  const [error, setError] = useState('');
  useEffect(() => {
    void window.vox!.generationAvailability().then(setAvailability).catch(() => setError('Generation status could not be checked. Close the builder and try again.'));
    return window.vox!.onGenerationProgress(setProgress);
  }, []);
  const missing = Object.fromEntries(MOTION_KINDS.map(kind => [kind, selection[kind].filter(effect => !hasMotion(character, kind, effect))])) as Selection;
  const count = missing.enter.length + missing.exit.length;
  const needsOpenAI = missing.enter.includes('walk') || missing.exit.includes('walk');
  const allReady = MOTION_KINDS.every(kind => MOTION_EFFECTS.every(effect => hasMotion(character, kind, effect)));
  const generate = async () => {
    if (busy || !count) return;
    setWorking(true); onWorking(true); setCancelling(false); setError(''); setProgress(undefined);
    try {
      const next = await window.vox!.generateCharacterMotions({ character, animations: missing });
      onAdded(next); setSelection({ enter: [], exit: [] });
    } catch (error) { setError((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
    finally { setWorking(false); onWorking(false); setCancelling(false); }
  };
  const cancel = async () => {
    setCancelling(true);
    try { await window.vox!.cancelGeneration(); }
    catch { setError('Could not cancel the request. Wait for generation to finish.'); setCancelling(false); }
  };
  return <section className="add-animations" aria-labelledby="add-animations-title" aria-busy={working}>
    <h3 id="add-animations-title">Add entrance and exit animations</h3>
    <p className="helper">{allReady ? 'All three entrance and exit types are available. Choose the active animations below.' : 'Select one or more missing animations. Your existing speech artwork and animation choices stay available.'}</p>
    <MotionSelection id="add-motion" selection={selection} onChange={selection => { setSelection(selection); setError(''); }} character={character} disabled={busy} />
    {!allReady && <>
      <p className="helper">{needsOpenAI ? 'Walking sends the saved resting artwork to OpenAI · API charges apply. Jump and smoke use the existing artwork locally.' : 'Jump and smoke use the existing artwork locally. Walking requires OpenAI.'} Preview the new choices, then Save changes.</p>
      {needsOpenAI && availability && !availability.available && <p className="inline-error" role="status">OpenAI is unavailable. Restart with OPENAI_API_KEY to generate walking artwork, or select jump and smoke.</p>}
      {working && <div className="generation-progress" role="status" aria-live="polite"><strong>{cancelling ? 'Cancelling…' : progress?.stage || 'Starting animation generation…'}</strong><progress max={progress?.total || 1} value={progress?.completed || 0} aria-label="Animation generation progress" /><p>Cancel stops remaining steps; OpenAI requests already sent may still be billed.</p></div>}
      <div className="creator-actions"><button id="generate-character-motions" className="primary" disabled={busy || !count || needsOpenAI && !availability?.available} onClick={() => void generate()}>{working ? 'Generating animations…' : 'Generate selected animations'}</button>
        {working && <button className="secondary" disabled={cancelling} onClick={() => void cancel()}>Cancel generation</button>}</div>
    </>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
