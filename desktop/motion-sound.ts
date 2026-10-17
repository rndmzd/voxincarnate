import type { Character, MotionSound } from './shared';
import type { MotionStart } from './animation';

export interface SoundAudio {
  currentTime: number;
  play(): Promise<void>;
  pause(): void;
}

/** Shared with the isolated OBS page; this factory must remain self-contained. */
export function createMotionSoundPlayer(
  url: (characterId: string, sound: MotionSound) => string,
  createAudio?: (source: string) => SoundAudio,
  onError?: (message: string) => void
) {
  let characterId = '';
  let sequence = 0;
  let audio: SoundAudio | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  const defaults = { createAudio(source: string): SoundAudio { return new Audio(source); } };
  const makeAudio = createAudio ?? defaults.createAudio;
  return {
    stop() {
      revision++;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (audio) { audio.pause(); try { audio.currentTime = 0; } catch { /* An undecoded sound has no seekable range. */ } }
      audio = undefined;
    },
    // A loaded/reconnected snapshot describes state, not a new sound command.
    baseline(id: string, nextSequence = 0) {
      this.stop(); characterId = id; sequence = nextSequence;
    },
    play(character: Character, start: MotionStart | undefined) {
      if (!start) return;
      if (characterId !== character.id) this.baseline(character.id);
      if (start.sequence <= sequence) return;
      sequence = start.sequence;
      this.stop();
      const sound = character.motionSounds?.[start.effect];
      if (!sound) return;
      const current = revision;
      try {
        audio = makeAudio(url(character.id, sound));
        // Play once; long clips end with the animation and interruptions replace them.
        const pending = audio.play();
        timer = setTimeout(() => this.stop(), start.durationMs);
        void pending.catch(() => {
          if (revision !== current) return;
          this.stop(); onError?.(`Could not play ${sound.name}. Try another WAV file or enable audio playback.`);
        });
      } catch {
        this.stop(); onError?.(`Could not play ${sound.name}. Try another WAV file or enable audio playback.`);
      }
    }
  };
}
