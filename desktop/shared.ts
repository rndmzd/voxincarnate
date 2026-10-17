export interface Sprite {
  id: string; file: string; name: string; x: number; y: number; scale: number;
}
export const VISEMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'X'] as const;
export type Viseme = typeof VISEMES[number];
export type MouthPose = 'closed' | 'open' | Viseme;
export type MotionKind = 'enter' | 'exit';
export type AssetPose = MouthPose | MotionKind;
export type MotionEffect = 'walk' | 'smoke' | 'fall-jump';
export interface MotionClip {
  frames: Sprite[]; frameMs: number; durationMs: number; side: 'left' | 'right';
  effect?: MotionEffect;
  facing?: 'left' | 'right';
}
export interface NormalizedRegion { x: number; y: number; width: number; height: number }
export interface CharacterPresence { visible: boolean; sequence: number }
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
}
export function spritesForPose(character: Character, pose: AssetPose): Sprite[] {
  if (pose === 'enter' || pose === 'exit') return character.motions?.[pose]?.frames ?? [];
  return pose === 'closed' || pose === 'open' ? character[pose] : character.visemes?.[pose] ?? [];
}
export function characterSprites(character: Character): Sprite[] {
  return [...character.closed, ...character.open, ...VISEMES.flatMap(pose => character.visemes?.[pose] ?? []),
    ...(character.motions?.enter?.frames ?? []), ...(character.motions?.exit?.frames ?? [])];
}
export interface DetectorSettings {
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
}
export interface GenerationProgress { stage: string; completed: number; total: number }
export interface GenerationAvailability { available: boolean; imageModel: string; textModel: string }
export interface InputDevice { deviceId: string; label: string }
export interface BrowserStatus {
  url: string; loading?: boolean; error?: string; devices?: InputDevice[];
  actualInput?: string; message?: string;
}
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  saveCharacter(character: Character): Promise<Bootstrap>;
  deleteCharacter(characterId: string): Promise<Bootstrap>;
  createVisemeDemo(): Promise<Bootstrap>;
  importImages(characterId: string, pose: AssetPose): Promise<Sprite[]>;
  generationAvailability(): Promise<GenerationAvailability>;
  chooseCharacterSource(): Promise<CharacterSource | undefined>;
  detectCharacterFace(sourceId: string): Promise<SpeechRegionDetection>;
  generateCharacter(request: CharacterGenerationRequest): Promise<Character>;
  discardCharacterDraft(characterId: string): Promise<void>;
  cancelGeneration(): Promise<void>;
  onGenerationProgress(listener: (progress: GenerationProgress) => void): () => void;
  setCharacterPresence(characterId: string, visible: boolean): Promise<CharacterPresence>;
  saveSettings(settings: AppSettings): Promise<Bootstrap>;
  publish(state: Omit<AvatarState, 'timestamp' | 'sequence'>): void;
  browser(action: 'navigate' | 'back' | 'forward' | 'reload' | 'devices' | 'input' | 'stop', value?: string): Promise<void>;
  browserBounds(bounds: { x: number; y: number; width: number; height: number; visible: boolean }): void;
  onBrowserStatus(listener: (status: BrowserStatus) => void): () => void;
  copy(text: string): Promise<void>;
}
export const DEFAULT_DETECTOR: DetectorSettings = {
  gain: 1, openThresholdDb: -38, closeThresholdDb: -45,
  attackMs: 25, releaseMs: 90, holdMs: 90
};
export function overlayUrl(data: Bootstrap, id: string): string {
  return `${data.overlayOrigin}/overlay/${encodeURIComponent(id)}?token=${data.token}`;
}
export function spriteUrl(data: Bootstrap, id: string, sprite: Sprite): string {
  return `${data.overlayOrigin}/assets/${encodeURIComponent(id)}/${encodeURIComponent(sprite.file)}?token=${data.token}`;
}
