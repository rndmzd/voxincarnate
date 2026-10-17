import type { AvatarState, Character, CharacterPresence, MotionClip, MotionEffect, Sprite, Viseme } from './shared';

/** Shared by the studio and the isolated OBS page; keep the factory self-contained. */
export function createAvatarAnimator() {
  let character: Character | undefined;
  let state: Pick<AvatarState, 'running' | 'speaking' | 'articulation'> = { running: false, speaking: false };
  let pose = 'closed';
  let poseStarted = 0;
  let pendingWideAt = 0;

  return {
    update(next: Character, input: Pick<AvatarState, 'running' | 'speaking' | 'articulation'>, now: number) {
      if (character?.id !== next.id || character.animationMode !== next.animationMode) {
        pose = 'closed';
        poseStarted = now;
        pendingWideAt = 0;
      }
      character = next;
      state = input;
      // Anchor transitions to receipt time, even when the next paint is delayed.
      this.frame(now);
    },
    frame(now: number): Sprite | undefined {
      if (!character) return;
      const visemeMode = character.animationMode === 'viseme';
      const visemes = character.visemes || {};
      let desired = 'closed';
      let strongest = 0;
      if (state.running && state.speaking) {
        desired = 'open';
        if (visemeMode && state.articulation) {
          for (const key of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'] as const) {
            const weight = state.articulation.weights[key];
            if (typeof weight === 'number' && Number.isFinite(weight) && weight > strongest) {
              strongest = weight;
              desired = key;
            }
          }
        }
      } else if (visemeMode && visemes.X?.length) desired = 'X';

      // Bilabial closures and silence must never wait behind a vowel transition.
      const immediate = desired === 'closed' || desired === 'A' || desired === 'X';
      if (immediate) pendingWideAt = 0;
      if (pendingWideAt && desired !== 'D') pendingWideAt = 0;
      if (pendingWideAt && now >= pendingWideAt) {
        pose = 'D';
        poseStarted = now;
        pendingWideAt = 0;
      }
      if (desired !== pose && !pendingWideAt) {
        const currentWeight = state.articulation?.weights[pose as Viseme] || 0;
        const previousIsViseme = pose.length === 1 && pose !== 'A' && pose !== 'X';
        const nextIsViseme = desired.length === 1;
        const dwell = previousIsViseme && nextIsViseme && !immediate && now - poseStarted < 40;
        const uncertain = previousIsViseme && nextIsViseme && !immediate && currentWeight > 0 && strongest < currentWeight + 0.12;
        if (!dwell && !uncertain) {
          const fromClosed = pose === 'closed' || pose === 'X' || pose === 'A';
          if (desired === 'D' && fromClosed && visemes.C?.length) {
            pose = 'C';
            pendingWideAt = now + 32;
          } else pose = desired;
          poseStarted = now;
        }
      }

      let frames: Sprite[];
      if (pose === 'closed') frames = character.closed;
      else if (pose === 'open') frames = character.open;
      else frames = visemes[pose as Viseme] || ((pose === 'A' || pose === 'X') ? character.closed : character.open);
      if (!frames.length) frames = (pose === 'closed' || pose === 'A' || pose === 'X') ? character.closed : character.open;
      if (!frames.length) frames = character.closed;
      const elapsed = Math.max(0, now - poseStarted);
      return frames[Math.floor(elapsed / Math.max(1, character.frameMs)) % Math.max(1, frames.length)];
    },
    isClosed() { return pose === 'closed' || pose === 'A' || pose === 'X'; },
    reset() {
      character = undefined;
      state = { running: false, speaking: false };
      pose = 'closed';
      poseStarted = 0;
      pendingWideAt = 0;
    }
  };
}

export interface MotionBounds { left: number; right: number; top: number; bottom: number }
export interface MotionStart { sequence: number; effect: MotionEffect; durationMs: number }
export interface MotionGeometry {
  /** Visible viewport dimensions, in character canvas units. */
  width: number; height: number;
  /** Union of decoded, transformed, nontransparent pixels, relative to the canvas center. */
  bounds?: MotionBounds;
  /** Per-sprite transformed alpha bounds prevent unrelated artwork from adding travel padding. */
  spriteBounds?: Record<string, MotionBounds>;
}

/** Canvas-space motion; serializable so studio and OBS use the same timeline. */
export function createMotionAnimator() {
  let character: Character | undefined;
  let presence: CharacterPresence = { visible: true, sequence: 0 };
  let visible = true;
  let offsetX = 0;
  let offsetY = 0;
  let geometry: MotionGeometry = { width: 1, height: 1 };
  let motion: { clip: MotionClip; started: number; duration: number; fromX: number; fromY: number; toX: number; toY: number; entering: boolean; flipX: boolean } | undefined;
  // Object methods avoid bundler-generated function-name helpers in serialized source.
  const calculations = {
    smooth(value: number) { const p = Math.max(0, Math.min(1, value)); return p * p * (3 - 2 * p); },
    validBounds(bounds: MotionBounds | undefined): bounds is MotionBounds {
      return !!bounds && [bounds.left, bounds.right, bounds.top, bounds.bottom].every(Number.isFinite) && bounds.right > bounds.left && bounds.bottom > bounds.top;
    },
    restBounds(): MotionBounds {
      const original = character!.closed[0] ?? character!.open[0];
      return (original && geometry.spriteBounds?.[original.id]) ?? geometry.bounds ?? { left: -character!.width / 2, right: character!.width / 2, top: -character!.height / 2, bottom: character!.height / 2 };
    },
    edge(clip: MotionClip, flipX: boolean, vertical = false, entering = false): number {
      let bounds = geometry.bounds ?? { left: -character!.width / 2, right: character!.width / 2, top: -character!.height / 2, bottom: character!.height / 2 };
      if ((clip.effect ?? 'walk') === 'walk') {
        // Entry begins with the first gait frame touching the screen. Exit uses the
        // gait union so every cycling frame has left before visibility is cleared.
        const frames = entering ? clip.frames.slice(0, 1) : clip.frames;
        const boxes = frames.map(frame => geometry.spriteBounds?.[frame.id]).filter(calculations.validBounds);
        if (boxes.length) bounds = { left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)), top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)) };
      } else {
        bounds = calculations.restBounds();
      }
      if (vertical) return -geometry.height / 2 - bounds.bottom;
      const left = flipX ? -bounds.right : bounds.left;
      const right = flipX ? -bounds.left : bounds.right;
      return clip.side === 'left' ? -geometry.width / 2 - right : geometry.width / 2 - left;
    },
    readGeometry(next: Character, input?: MotionGeometry): MotionGeometry {
      const width = input && Number.isFinite(input.width) && input.width > 0 ? input.width : Math.max(1, next.width);
      const height = input && Number.isFinite(input.height) && input.height > 0 ? input.height : Math.max(1, next.height);
      const bounds = input?.bounds;
      const spriteBounds = input?.spriteBounds && typeof input.spriteBounds === 'object' && !Array.isArray(input.spriteBounds) ? Object.fromEntries(Object.entries(input.spriteBounds).filter(([, box]) => calculations.validBounds(box)).map(([id, box]) => [id, { ...box }])) : undefined;
      return { width, height, ...(calculations.validBounds(bounds) ? { bounds: { ...bounds } } : {}), ...(spriteBounds ? { spriteBounds } : {}) };
    }
  };

  return {
    update(next: Character, input: CharacterPresence | undefined, now: number, viewport?: MotionGeometry): MotionStart | undefined {
      const changedCharacter = character?.id !== next.id;
      if (changedCharacter) {
        presence = { visible: true, sequence: 0 };
        visible = true;
        offsetX = offsetY = 0;
        motion = undefined;
      }
      character = next;
      const previousGeometry = geometry;
      const nextGeometry = calculations.readGeometry(next, viewport);
      // Resizing retargets the remaining journey from the last painted position.
      if (motion && JSON.stringify(previousGeometry) !== JSON.stringify(nextGeometry)) {
        const current = this.frame(now);
        geometry = nextGeometry;
        if (motion) {
          const elapsed = Math.max(0, now - motion.started);
          if (elapsed === 0 && motion.entering) {
            motion.fromX = motion.clip.effect === 'fall-jump' || motion.clip.effect === 'smoke' ? 0 : calculations.edge(motion.clip, motion.flipX, false, true);
            motion.fromY = motion.clip.effect === 'fall-jump' ? calculations.edge(motion.clip, false, true, true) : 0;
          } else if ((motion.clip.effect ?? 'walk') === 'walk') {
            motion.fromX = current.offsetX;
            motion.started = now;
            motion.duration = Math.max(1, motion.duration - elapsed);
          }
          motion.toX = !motion.entering && (motion.clip.effect ?? 'walk') === 'walk' ? calculations.edge(motion.clip, motion.flipX) : 0;
          motion.toY = !motion.entering && motion.clip.effect === 'fall-jump' ? calculations.edge(motion.clip, false, true) : 0;
        }
      } else geometry = nextGeometry;
      if (!input || typeof input.visible !== 'boolean' || !Number.isSafeInteger(input.sequence) || input.sequence < 0) return;
      // Sequence zero describes the initial resting state; stale snapshots cannot replay a command.
      if (changedCharacter && input.sequence === 0) {
        presence = { ...input };
        visible = input.visible;
        return;
      }
      if (input.sequence <= presence.sequence) return;
      const current = this.frame(now);
      const interrupted = !!motion;
      presence = { ...input };
      const kind = input.visible ? 'enter' : 'exit';
      const selected = next.motions?.[kind];
      let clip = selected;
      if (input.effect !== undefined && (!selected || (selected.effect ?? 'walk') !== input.effect)) clip = next.motionVariants?.[kind]?.[input.effect];
      if (!clip || ((clip.effect ?? 'walk') === 'walk' && !clip.frames.length) || !Number.isFinite(clip.durationMs) || clip.durationMs <= 0) {
        motion = undefined;
        visible = input.visible;
        offsetX = offsetY = 0;
        return;
      }
      if (!input.visible && !current.visible) return;
      const effect = clip.effect ?? 'walk';
      const travelingLeft = input.visible ? (interrupted ? current.offsetX > 0 : clip.side === 'right') : clip.side === 'left';
      const flipX = effect === 'walk' && travelingLeft !== (clip.facing === 'left');
      const outside = calculations.edge(clip, flipX, false, input.visible);
      const fromX = effect === 'walk' ? (input.visible && !interrupted ? outside : current.offsetX) : 0;
      const toX = effect === 'walk' && !input.visible ? outside : 0;
      const fromY = effect === 'fall-jump' && input.visible ? calculations.edge(clip, false, true, true) : 0;
      const toY = effect === 'fall-jump' && !input.visible ? calculations.edge(clip, false, true) : 0;
      // A reversal preserves the painted position and the clip's walking speed.
      const duration = effect === 'walk' ? Math.max(1, clip.durationMs * Math.abs(toX - fromX) / Math.max(1, Math.abs(outside))) : clip.durationMs;
      motion = { clip, started: now, duration, fromX, fromY, toX, toY, entering: input.visible, flipX };
      visible = true;
      offsetX = fromX; offsetY = fromY;
      return { sequence: input.sequence, effect, durationMs: duration };
    },
    frame(now: number): { sprite?: Sprite; offsetX: number; offsetY: number; opacity: number; scale: number; flipX: boolean; visible: boolean; active: boolean; smoke: number } {
      if (motion) {
        const elapsed = Math.max(0, now - motion.started);
        const progress = Math.min(1, elapsed / motion.duration);
        if (progress >= 1) {
          visible = motion.entering;
          offsetX = offsetY = 0;
          motion = undefined;
        } else {
          const effect = motion.clip.effect ?? 'walk';
          let opacity = 1; let scale = 1; let smoke = 0;
          offsetX = motion.fromX + (motion.toX - motion.fromX) * progress;
          offsetY = 0;
          if (effect === 'smoke') {
            opacity = motion.entering ? calculations.smooth((progress - 0.16) / 0.38) : 1 - calculations.smooth((progress - 0.2) / 0.35);
            smoke = Math.pow(Math.sin(progress * Math.PI), 0.8);
          } else if (effect === 'fall-jump') {
            if (motion.entering) {
              // Four ballistic bounces give a clear landing without changing the artwork.
              const n = 7.5625; const d = 2.75; let p = progress; let bounce: number;
              if (p < 1 / d) bounce = n * p * p;
              else if (p < 2 / d) { p -= 1.5 / d; bounce = n * p * p + 0.75; }
              else if (p < 2.5 / d) { p -= 2.25 / d; bounce = n * p * p + 0.9375; }
              else { p -= 2.625 / d; bounce = n * p * p + 0.984375; }
              offsetY = motion.fromY * (1 - bounce);
            } else if (progress < 0.18) {
              scale = 1 - 0.15 * calculations.smooth(progress / 0.18);
              offsetY = calculations.restBounds().bottom * (1 - scale);
            } else {
              const jump = (progress - 0.18) / 0.82;
              scale = 0.85 + 0.15 * calculations.smooth(jump / 0.25);
              offsetY = motion.toY * Math.pow(jump, 0.65) + calculations.restBounds().bottom * (1 - scale);
            }
          }
          const frameMs = Number.isFinite(motion.clip.frameMs) ? Math.max(1, motion.clip.frameMs) : 100;
          // Preserve gait metadata when switching effects, but local effects always
          // animate the original resting artwork rather than generated walk frames.
          const sprite = effect === 'walk' && motion.clip.frames.length ? motion.clip.frames[Math.floor(elapsed / frameMs) % motion.clip.frames.length] : character?.closed[0] ?? character?.open[0];
          return { sprite, offsetX, offsetY, opacity, scale, flipX: motion.flipX, visible: true, active: true, smoke };
        }
      }
      return { offsetX, offsetY, opacity: 1, scale: 1, flipX: false, visible, active: false, smoke: 0 };
    },
    reset() {
      character = undefined;
      presence = { visible: true, sequence: 0 };
      visible = true;
      offsetX = offsetY = 0;
      motion = undefined;
    }
  };
}

/** Deterministic transparent-canvas smoke; safe to serialize into the isolated OBS page. */
export function drawSmokePuff(context: CanvasRenderingContext2D, amount: number, width: number, height: number): void {
  context.clearRect(0, 0, width, height);
  const density = Math.max(0, Math.min(1, amount));
  if (!density || width <= 0 || height <= 0) return;
  context.save();
  context.translate(width / 2, height / 2);
  const size = Math.min(width, height);
  const expansion = 0.74 + (1 - density) * 0.38;
  for (let index = 0; index < 32; index++) {
    const angle = index * 2.399963229728653;
    const ring = Math.sqrt((index + 0.5) / 32);
    const x = Math.cos(angle) * width * 0.35 * ring * expansion;
    const y = Math.sin(angle) * height * 0.37 * ring * expansion;
    const radius = size * (0.12 + (index % 5) * 0.013) * expansion;
    const shade = 169 + index % 4 * 14;
    const alpha = density * (0.58 + (index % 3) * 0.07);
    const gradient = context.createRadialGradient(x - radius * 0.18, y - radius * 0.22, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${shade},${shade},${shade},${alpha})`);
    gradient.addColorStop(0.62, `rgba(${shade - 22},${shade - 22},${shade - 22},${alpha * 0.8})`);
    gradient.addColorStop(1, `rgba(${shade - 35},${shade - 35},${shade - 35},0)`);
    context.fillStyle = gradient;
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}
