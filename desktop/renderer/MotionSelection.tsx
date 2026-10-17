import { MOTION_KINDS, MOTION_LABELS, type Character, type MotionEffect, type MotionSelection as Selection } from '../shared';
import { hasMotion } from '../character-motions';

const effects: MotionEffect[] = ['walk', 'fall-jump', 'smoke'];

export function MotionSelection({ id, selection, onChange, character, disabled }: {
  id: string; selection: Selection; onChange(selection: Selection): void; character?: Character; disabled?: boolean;
}) {
  return <div className="motion-selection">{MOTION_KINDS.map(kind => <fieldset key={kind} disabled={disabled}>
    <legend>{kind === 'enter' ? 'Entrance' : 'Exit'}</legend>
    {effects.map(effect => {
      const ready = !!character && hasMotion(character, kind, effect);
      return <label className={`motion-choice${ready ? ' available' : ''}`} key={effect} htmlFor={`${id}-${kind}-${effect}`}>
        <input id={`${id}-${kind}-${effect}`} type="checkbox" checked={ready || selection[kind].includes(effect)} disabled={ready}
          aria-label={`${kind === 'enter' ? 'Entrance' : 'Exit'} · ${MOTION_LABELS[kind][effect]}`}
          onChange={event => onChange({ ...selection, [kind]: event.target.checked ? [...selection[kind], effect] : selection[kind].filter(choice => choice !== effect) })} />
        <span>{MOTION_LABELS[kind][effect]}{ready && <small>Already available</small>}</span>
      </label>;
    })}
  </fieldset>)}</div>;
}
