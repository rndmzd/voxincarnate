import { MOTION_KINDS, MOTION_LABELS, type Character, type MotionEffect, type MotionKind } from '../shared';
import { hasMotion } from '../character-motions';

const effects: MotionEffect[] = ['walk', 'fall-jump', 'smoke'];

export function OnAirMotionControls({ character, disabledReason, onTrigger }: {
  character: Character; disabledReason?: string; onTrigger(kind: MotionKind, effect: MotionEffect): void;
}) {
  const anyAvailable = MOTION_KINDS.some(kind => effects.some(effect => hasMotion(character, kind, effect)));
  return <section className="obs-presence" aria-labelledby="on-air-motion-title">
    <h3 id="on-air-motion-title">On-air entrance / exit</h3>
    <div className="obs-motion-options">{MOTION_KINDS.map(kind => <fieldset key={kind} className="obs-motion-group">
      <legend>{kind === 'enter' ? 'Entrance' : 'Exit'}</legend>
      {effects.map(effect => {
        const available = hasMotion(character, kind, effect);
        const label = MOTION_LABELS[kind][effect];
        return <button id={`on-air-${kind}-${effect}`} key={effect} className="secondary" disabled={!!disabledReason || !available}
          aria-label={`${kind === 'enter' ? 'Enter' : 'Exit'} OBS with ${label}`}
          title={!available ? 'Add this animation in Edit character first.' : disabledReason || `${kind === 'enter' ? 'Enter' : 'Exit'} OBS with ${label}`}
          onClick={() => onTrigger(kind, effect)}>{label}</button>;
      })}
    </fieldset>)}</div>
    <p className="helper">{anyAvailable ? 'Choose an available animation to play in OBS. Add missing types in Edit character.' : 'Add entrance and exit animations in Edit character to enable these buttons.'} An exit keeps the character hidden until the next entrance. For sound effects, enable Control audio via OBS in the Browser Source properties.</p>
    {disabledReason && <p className="helper" role="status">{disabledReason}</p>}
  </section>;
}
