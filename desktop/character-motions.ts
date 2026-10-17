import { MOTION_EFFECTS, MOTION_KINDS, type Character, type MotionClip, type MotionEffect, type MotionKind, type MotionSelection, type MotionVariants } from './shared.js';

export function motionChoices(character: Character, kind: MotionKind): Partial<Record<MotionEffect, MotionClip>> {
  const choices = { ...character.motionVariants?.[kind] };
  const active = character.motions?.[kind];
  if (active) choices[active.effect ?? 'walk'] = active;
  return choices;
}

export function hasMotion(character: Character, kind: MotionKind, effect: MotionEffect): boolean {
  const clip = motionChoices(character, kind)[effect];
  return !!clip && (effect !== 'walk' || clip.frames.length > 0);
}

export function defaultMotion(effect: MotionEffect, side: 'left' | 'right' = 'right'): MotionClip {
  return { frames: [], frameMs: 120, durationMs: effect === 'walk' ? 1800 : 1000, side, effect, facing: 'right' };
}

export function generatedMotionChoices(selection: MotionSelection, frames: Partial<Record<MotionKind, MotionClip['frames']>>,
  entranceSide: 'left' | 'right' = 'right', exitSide = entranceSide): MotionVariants {
  return Object.fromEntries(MOTION_KINDS.map(kind => [kind, Object.fromEntries(selection[kind].map(effect => [effect, {
    ...defaultMotion(effect, kind === 'enter' ? entranceSide : exitSide), frames: effect === 'walk' ? frames[kind] ?? [] : []
  }]))]));
}

/** Move choices between active and inactive storage, preserving frames and per-clip settings. */
export function selectMotion(character: Character, kind: MotionKind, effect?: MotionEffect): Character {
  const choices = motionChoices(character, kind);
  const motions = { ...character.motions };
  if (effect) {
    motions[kind] = choices[effect] ?? defaultMotion(effect, character.motions?.[kind]?.side ?? character.motions?.enter?.side);
    delete choices[effect];
  } else delete motions[kind];
  // A walking placeholder without artwork is not an available animation.
  if (choices.walk && !choices.walk.frames.length) delete choices.walk;
  const motionVariants = { ...character.motionVariants, [kind]: choices };
  return { ...character, motions, motionVariants };
}

/** Add missing clips without changing a character's current playback choice. */
export function addMotionChoices(character: Character, additions: MotionVariants): Character {
  let next = character;
  for (const kind of MOTION_KINDS) {
    const choices = motionChoices(next, kind);
    for (const effect of MOTION_EFFECTS) {
      const clip = additions[kind]?.[effect];
      if (clip && !hasMotion(next, kind, effect)) choices[effect] = clip;
    }
    const active = next.motions?.[kind];
    const effect = active ? active.effect ?? 'walk' : MOTION_EFFECTS.find(candidate => choices[candidate]);
    const motions = { ...next.motions };
    if (effect && choices[effect]) { motions[kind] = choices[effect]; delete choices[effect]; }
    next = { ...next, motions, motionVariants: { ...next.motionVariants, [kind]: choices } };
  }
  return next;
}

/** Validate before making requests; duplicated or unsupported choices never become billable work. */
export function validateMotionSelection(value: unknown, requireBoth = false): asserts value is MotionSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !MOTION_KINDS.includes(key as MotionKind))) {
    throw new Error('Choose supported entrance and exit animations.');
  }
  const selection = value as MotionSelection;
  for (const kind of MOTION_KINDS) {
    const effects = selection[kind];
    if (!Array.isArray(effects) || effects.length > 3 || effects.some(effect => !MOTION_EFFECTS.includes(effect)) || new Set(effects).size !== effects.length) {
      throw new Error('Choose each walk, jump or smoke animation once.');
    }
    if (requireBoth && !effects.length) throw new Error('Choose at least one entrance and one exit animation.');
  }
  if (!selection.enter.length && !selection.exit.length) throw new Error('Choose at least one animation to add.');
}

export function missingMotionSelection(character: Character, selection: MotionSelection): MotionSelection {
  validateMotionSelection(selection);
  for (const kind of MOTION_KINDS) for (const effect of selection[kind]) {
    if (hasMotion(character, kind, effect)) throw new Error('This character already has a selected animation. Choose only missing animations.');
  }
  return selection;
}
