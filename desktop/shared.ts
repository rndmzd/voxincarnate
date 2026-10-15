export interface Sprite {
  id: string; file: string; name: string; x: number; y: number; scale: number;
}
export interface Character {
  id: string; name: string; width: number; height: number;
  closed: Sprite[]; open: Sprite[]; frameMs: number;
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
  version: 1; token: string; characters: Character[]; settings: AppSettings;
}
export interface Bootstrap extends Library { overlayOrigin: string }
export interface AvatarState {
  characterId: string; level: number; db: number; speaking: boolean;
  running: boolean; timestamp: number; sequence: number;
}
export interface InputDevice { deviceId: string; label: string }
export interface BrowserStatus {
  url: string; loading?: boolean; error?: string; devices?: InputDevice[];
  actualInput?: string; message?: string;
}
export interface DesktopApi {
  bootstrap(): Promise<Bootstrap>;
  saveCharacter(character: Character): Promise<Bootstrap>;
  importImages(characterId: string, pose: 'closed' | 'open'): Promise<Sprite[]>;
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
