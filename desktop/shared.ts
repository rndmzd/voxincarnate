export interface Sprite {
  id: string; file: string; name: string; x: number; y: number; scale: number;
}
export const VISEMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'] as const;
export type Viseme = typeof VISEMES[number];
export type MouthPose = 'closed' | 'open' | Viseme;
export type MotionKind = 'enter' | 'exit';
export type AssetPose = MouthPose | MotionKind;
export type MotionEffect = 'walk' | 'smoke' | 'fall-jump';
export const MOTION_EFFECTS: MotionEffect[] = ['walk', 'smoke', 'fall-jump'];
export const MOTION_KINDS: MotionKind[] = ['enter', 'exit'];
export const MOTION_LABELS: Record<MotionKind, Record<MotionEffect, string>> = {
  enter: { walk: 'Walk on', 'fall-jump': 'Jump in', smoke: 'Puff of smoke' },
  exit: { walk: 'Walk off', 'fall-jump': 'Jump out', smoke: 'Puff of smoke' }
};
export type MotionSelection = Record<MotionKind, MotionEffect[]>;
export type MotionVariants = Partial<Record<MotionKind, Partial<Record<MotionEffect, MotionClip>>>>;
export interface MotionSound { file: string; name: string }
export const SOUND_PRESETS = [
  { id: 'puff_of_smoke', name: 'Puff of smoke', file: 'puff_of_smoke.wav' },
  { id: 'footsteps', name: 'Footsteps', file: 'footsteps.wav' }
] as const;
export type SoundPreset = typeof SOUND_PRESETS[number]['id'];
export interface MotionClip {
  frames: Sprite[]; frameMs: number; durationMs: number; side: 'left' | 'right';
  effect?: MotionEffect;
  facing?: 'left' | 'right';
}
export interface NormalizedRegion { x: number; y: number; width: number; height: number }
export interface CharacterPresence { visible: boolean; sequence: number; effect?: MotionEffect }
export const VISEME_LABELS: Record<Viseme, string> = {
  A: 'Closed · P / B / M', B: 'Teeth · EE / S / T', C: 'Open · EH / AE',
  D: 'Wide · AH', E: 'Rounded · OH', F: 'Puckered · OO',
  G: 'Lip bite · F / V', H: 'Tongue · L', X: 'Rest'
};
export type VisemeWeights = Partial<Record<Viseme, number>>;
/** AudioContext-relative acquisition time, separate from server liveness time. */
export interface Articulation { weights: VisemeWeights; audioTimeMs: number }
export interface Character {
  id: string; name: string; width: number; height: number;
  closed: Sprite[]; open: Sprite[]; frameMs: number;
  animationMode?: 'binary' | 'viseme';
  visemes?: Partial<Record<Viseme, Sprite[]>>;
  motions?: Partial<Record<MotionKind, MotionClip>>;
  /** Additional choices; the active clip lives in motions, without duplicate sprites. */
  motionVariants?: MotionVariants;
  /** One optional sound per effect, shared by entrance and exit. */
  motionSounds?: Partial<Record<MotionEffect, MotionSound>>;
}
export function spritesForPose(character: Character, pose: AssetPose): Sprite[] {
  if (pose === 'enter' || pose === 'exit') return character.motions?.[pose]?.frames ?? [];
  return pose === 'closed' || pose === 'open' ? character[pose] : character.visemes?.[pose] ?? [];
}
export function characterSprites(character: Character): Sprite[] {
  return [...character.closed, ...character.open, ...VISEMES.flatMap(pose => character.visemes?.[pose] ?? []),
    ...(character.motions?.enter?.frames ?? []), ...(character.motions?.exit?.frames ?? []),
    ...MOTION_KINDS.flatMap(kind => MOTION_EFFECTS.flatMap(effect => character.motionVariants?.[kind]?.[effect]?.frames ?? []))];
}
export interface DetectorSettings {
  // closeThresholdDb is retained for compatibility with existing saved libraries.
  // Speech activity uses openThresholdDb for both opening and returning to rest.
  gain: number; openThresholdDb: number; closeThresholdDb: number;
  attackMs: number; releaseMs: number; holdMs: number;
}
export interface AppSettings {
  activeCharacterId: string; mode: 'direct' | 'browser'; inputId: string;
  browserInputId: string; assistantUrl: string; overlayPort: number; detector: DetectorSettings;
}
export interface Library {
  version: 2; token: string; characters: Character[]; settings: AppSettings;
}
export interface Bootstrap extends Library { overlayOrigin: string }
export interface AvatarState {
  characterId: string; level: number; db: number; speaking: boolean;
  running: boolean; timestamp: number; sequence: number;
  articulation?: Articulation;
  presence?: CharacterPresence;
}
export interface CharacterSource { id: string; name: string; previewUrl: string; width: number; height: number }
export interface SpeechRegionDetection { faceRegion: NormalizedRegion; mouthRegion: NormalizedRegion }
export interface CharacterGenerationRequest {
  name: string; sourceId?: string; description?: string; style?: string;
  mouthRegion?: NormalizedRegion; faceRegion?: NormalizedRegion; speechMode?: 'mouth' | 'face';
  entranceSide?: 'left' | 'right'; exitSide?: 'left' | 'right';
  entranceEffect?: MotionEffect; exitEffect?: MotionEffect;
  animations?: MotionSelection;
}
export interface CharacterMotionGenerationRequest { character: Character; animations: MotionSelection }
export interface GenerationProgress { stage: string; completed: number; total: number }
export interface GenerationAvailability { available: boolean; imageModel: string; textModel: string }
export interface InputDevice { deviceId: string; label: string }
export interface BrowserStatus {
  url: string; loading?: boolean; error?: string; devices?: InputDevice[];
  actualInput?: string; message?: string;
}
export interface DesktopApi {
  controlInfo(): Promise<import('./control-protocol').ControlInfo>;
  saveControlSettings(settings: import('./control-protocol').ControlSettings): Promise<import('./control-protocol').ControlInfo>;
  control(command: import('./control-protocol').ControlCommand): Promise<import('./control-protocol').ControlResponse>;
  controlRuntime(runtime: import('./control-protocol').ControlRuntime): void;
  onControlState(listener: (state: import('./control-protocol').ControlState) => void): () => void;
  onControlResult(listener: (result: import('./control-protocol').ControlResult) => void): () => void;
  pauseHotkeys(paused: boolean): Promise<void>;
  installStreamDeckPlugin(): Promise<void>;
  bootstrap(): Promise<Bootstrap>;
  saveCharacter(character: Character): Promise<Bootstrap>;
  renameCharacter(characterId: string, name: string): Promise<Bootstrap>;
  deleteCharacter(characterId: string): Promise<Bootstrap>;
  createVisemeDemo(): Promise<Bootstrap>;
  importImages(characterId: string, pose: AssetPose): Promise<Sprite[]>;
  importMotionSound(characterId: string, preset?: SoundPreset): Promise<MotionSound | undefined>;
  generationAvailability(): Promise<GenerationAvailability>;
  chooseCharacterSource(): Promise<CharacterSource | undefined>;
  detectCharacterFace(sourceId: string): Promise<SpeechRegionDetection>;
  generateCharacter(request: CharacterGenerationRequest): Promise<Character>;
  generateCharacterMotions(request: CharacterMotionGenerationRequest): Promise<Character>;
  discardCharacterDraft(characterId: string): Promise<void>;
  cancelGeneration(): Promise<void>;
  onGenerationProgress(listener: (progress: GenerationProgress) => void): () => void;
  setCharacterPresence(characterId: string, visible: boolean, effect?: MotionEffect): Promise<CharacterPresence>;
  saveSettings(settings: AppSettings): Promise<Bootstrap>;
  publish(state: Omit<AvatarState, 'timestamp' | 'sequence'>): void;
  browser(action: 'navigate' | 'back' | 'forward' | 'reload' | 'devices' | 'input' | 'stop', value?: string): Promise<void>;
  browserBounds(bounds: { x: number; y: number; width: number; height: number; visible: boolean }): void;
  onBrowserStatus(listener: (status: BrowserStatus) => void): () => void;
  copy(text: string): Promise<void>;
}
export const DEFAULT_DETECTOR: DetectorSettings = {
  gain: 1, openThresholdDb: -38, closeThresholdDb: -38,
  attackMs: 25, releaseMs: 90, holdMs: 250
};
export function overlayUrl(data: Bootstrap, id: string): string {
  return `${data.overlayOrigin}/overlay/${encodeURIComponent(id)}?token=${data.token}`;
}
export function spriteUrl(data: Bootstrap, id: string, sprite: Sprite): string {
  return `${data.overlayOrigin}/assets/${encodeURIComponent(id)}/${encodeURIComponent(sprite.file)}?token=${data.token}`;
}
export function motionSoundUrl(data: Bootstrap, id: string, sound: MotionSound): string {
  return `${data.overlayOrigin}/assets/${encodeURIComponent(id)}/${encodeURIComponent(sound.file)}?token=${data.token}`;
}
