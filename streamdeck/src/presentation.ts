import { commandIssue, type ControlCommand, type ControlState } from '../../desktop/control-protocol.js';

export function presentation(command: ControlCommand, state?: ControlState): { title: string; color: string; active: boolean } {
  const gray = '#899da5', green = '#8de0c3', amber = '#f4c17d';
  if (!state) return { title: 'App\noffline', color: gray, active: false };
  const issue = commandIssue(state, command);
  if (issue) {
    const titles: Record<string, string> = { not_ready: 'Opening…', busy: 'Working…', unsaved_changes: 'Save\nchanges', input_required: 'Choose\ninput', animation_missing: 'Add\nanimation', character_missing: 'Choose\ncharacter', audio_running: 'Stop audio\nto refresh' };
    return { title: titles[issue.code!] ?? 'Check\nstudio', color: amber, active: false };
  }
  if (command.action.startsWith('audio.')) {
    const title = command.action === 'audio.start' ? (state.running ? 'Capturing' : state.mode === 'browser' ? 'Capture\nassistant' : 'Start\naudio') : command.action === 'audio.stop' ? 'Stop\naudio' : state.running ? 'Stop\naudio' : 'Start\naudio';
    return { title, color: state.running ? green : gray, active: state.running };
  }
  if (command.action === 'inputs.refresh') return { title: 'Refresh\ninputs', color: green, active: false };
  const enter = command.action === 'character.enter';
  const character = state.characters.find(c => c.id === (command.characterId ?? state.activeCharacterId));
  const label = command.effect === 'walk' ? `Walk ${enter ? 'on' : 'off'}` : command.effect === 'fall-jump' ? `Jump ${enter ? 'in' : 'out'}` : command.effect === 'smoke' ? `Smoke ${enter ? 'in' : 'out'}` : enter ? 'Entrance' : 'Exit';
  return { title: `${label}\n${character?.visible ? 'Visible' : 'Hidden'}`, color: character?.visible ? green : gray, active: !!character?.visible };
}

export function buttonImage(color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" rx="16" fill="#172026"/><path d="M35 39L54 72L73 30L92 62L109 39" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
