import { MOTION_EFFECTS, type InputDevice, type MotionEffect, type MotionKind } from './shared.js';

export const CONTROL_API_VERSION = 1;
export const CONTROL_PORT = 48242;
export const CONTROL_ACTIONS = ['audio.start', 'audio.stop', 'audio.toggle', 'inputs.refresh', 'character.enter', 'character.exit'] as const;
export type ControlAction = typeof CONTROL_ACTIONS[number];
export type ControlCommand = { action: ControlAction; characterId?: string; effect?: MotionEffect };
export interface HotkeyBinding { id: string; accelerator: string; command: ControlCommand }
export interface ControlSettings { enabled: boolean; port: number; hotkeys: HotkeyBinding[] }
export interface ControlConfig extends ControlSettings { version: 1; token: string }
export interface ControlRuntime {
  ready: boolean; busy: boolean; dirty: boolean; running: boolean;
  mode: 'direct' | 'browser'; activeCharacterId: string; selectedInputId: string;
  inputs: InputDevice[]; error?: string;
}
export interface ControlCharacter {
  id: string; name: string; visible: boolean;
  motions: Record<MotionKind, MotionEffect[]>;
}
export interface ControlState extends ControlRuntime {
  apiVersion: 1; characters: ControlCharacter[]; revision: number;
}
export interface ControlResult { ok: boolean; code?: string; message?: string }
export interface ControlResponse extends ControlResult { state: ControlState }
export interface ControlInfo {
  settings: ControlSettings; token: string; listening: boolean; error?: string;
  hotkeyErrors: Record<string, string>;
}
export const EMPTY_RUNTIME: ControlRuntime = {
  ready: false, busy: false, dirty: false, running: false, mode: 'direct', activeCharacterId: '', selectedInputId: '', inputs: []
};
export const ACTION_LABELS: Record<ControlAction, string> = {
  'audio.start': 'Start audio capture', 'audio.stop': 'Stop audio', 'audio.toggle': 'Toggle audio',
  'inputs.refresh': 'Refresh microphone inputs', 'character.enter': 'Entrance', 'character.exit': 'Exit'
};

export function parseCommand(value: unknown): ControlCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Send a command object.');
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some(key => !['action', 'characterId', 'effect'].includes(key)) || !CONTROL_ACTIONS.includes(c.action as ControlAction)) throw new Error('Unknown control action.');
  const motion = c.action === 'character.enter' || c.action === 'character.exit';
  if ((!motion && (c.characterId !== undefined || c.effect !== undefined)) ||
      (c.characterId !== undefined && (typeof c.characterId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(c.characterId))) ||
      (c.effect !== undefined && !MOTION_EFFECTS.includes(c.effect as MotionEffect))) throw new Error('Invalid character or animation choice.');
  return { action: c.action as ControlAction, ...(c.characterId ? { characterId: c.characterId as string } : {}), ...(c.effect ? { effect: c.effect as MotionEffect } : {}) };
}

export function parseControlSettings(value: unknown): ControlSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid control settings.');
  const s = value as ControlSettings;
  if (typeof s.enabled !== 'boolean' || !Number.isInteger(s.port) || s.port < 1024 || s.port > 65535 || !Array.isArray(s.hotkeys) || s.hotkeys.length > 40) throw new Error('Choose a port from 1024 to 65535 and at most 40 hotkeys.');
  const ids = new Set<string>(); const keys = new Set<string>();
  const hotkeys = s.hotkeys.map(row => {
    if (!row || typeof row.id !== 'string' || !/^[a-z0-9._-]{1,80}$/i.test(row.id) || ids.has(row.id) || typeof row.accelerator !== 'string' || row.accelerator.length > 100) throw new Error('Invalid or duplicated hotkey row.');
    ids.add(row.id);
    const accelerator = row.accelerator.trim();
    if (accelerator && keys.has(accelerator.toLowerCase())) throw new Error('Each hotkey must use a different shortcut.');
    if (accelerator) keys.add(accelerator.toLowerCase());
    return { id: row.id, accelerator, command: parseCommand(row.command) };
  });
  return { enabled: s.enabled, port: s.port, hotkeys };
}

export function defaultHotkeys(): HotkeyBinding[] {
  return [
    ...(['audio.start', 'audio.stop', 'audio.toggle', 'inputs.refresh'] as const).map(action => ({ id: action, accelerator: '', command: { action } })),
    ...(['enter', 'exit'] as const).flatMap(kind => [undefined, ...MOTION_EFFECTS].map(effect => ({
      id: `${kind}.${effect ?? 'default'}`, accelerator: '', command: { action: `character.${kind}` as ControlAction, ...(effect ? { effect } : {}) }
    })))
  ];
}

/** Used by the app and plugin so disabled actions carry the same explanation. */
export function commandIssue(state: ControlState, command: ControlCommand): ControlResult | undefined {
  const fail = (code: string, message: string) => ({ ok: false, code, message });
  if (!state.ready) return fail('not_ready', 'The studio is opening. Try again when it is ready.');
  // Stop remains available during startup, editing, and other work.
  if (command.action === 'audio.stop') return;
  if (state.busy) return fail('busy', 'Wait for the current action to finish.');
  if (command.action === 'audio.start' && state.running) return;
  if (command.action === 'audio.toggle' && state.running) return;
  if (command.action === 'inputs.refresh') {
    if (state.running) return fail('audio_running', 'Stop audio before refreshing microphone inputs.');
    return;
  }
  if (state.dirty) return fail('unsaved_changes', 'Save changes before starting audio or an on-air animation.');
  if (command.action.startsWith('audio.')) {
    if (!state.selectedInputId || !state.inputs.some(input => input.deviceId === state.selectedInputId)) return fail('input_required', 'Refresh microphone inputs, choose a microphone, and save before starting audio.');
    return;
  }
  const character = state.characters.find(c => c.id === (command.characterId ?? state.activeCharacterId));
  if (!character) return fail('character_missing', 'Choose a saved character.');
  const kind = command.action === 'character.enter' ? 'enter' : 'exit';
  if (command.effect && !character.motions[kind].includes(command.effect)) return fail('animation_missing', 'Add this entrance or exit animation in Edit character first.');
}
