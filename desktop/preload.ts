import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, BrowserStatus, GenerationProgress } from './shared';
const api: DesktopApi = {
  controlInfo: () => ipcRenderer.invoke('control:info'),
  saveControlSettings: settings => ipcRenderer.invoke('control:settings', settings),
  control: command => ipcRenderer.invoke('control:execute', command),
  controlRuntime: runtime => ipcRenderer.send('control:runtime', runtime),
  onControlState: listener => {
    const receive = (_: unknown, state: import('./control-protocol').ControlState) => listener(state);
    ipcRenderer.on('control:state', receive); return () => ipcRenderer.removeListener('control:state', receive);
  },
  onControlResult: listener => {
    const receive = (_: unknown, result: import('./control-protocol').ControlResult) => listener(result);
    ipcRenderer.on('control:result', receive); return () => ipcRenderer.removeListener('control:result', receive);
  },
  pauseHotkeys: paused => ipcRenderer.invoke('control:pause-hotkeys', paused),
  installStreamDeckPlugin: () => ipcRenderer.invoke('control:install-plugin'),
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveCharacter: character => ipcRenderer.invoke('character:save', character),
  renameCharacter: (id, name) => ipcRenderer.invoke('character:rename', id, name),
  deleteCharacter: id => ipcRenderer.invoke('character:delete', id),
  createVisemeDemo: () => ipcRenderer.invoke('character:demo'),
  importImages: (id, pose) => ipcRenderer.invoke('character:import', id, pose),
  importMotionSound: (id, preset) => ipcRenderer.invoke('character:import-sound', id, preset),
  generationAvailability: () => ipcRenderer.invoke('generation:availability'),
  chooseCharacterSource: () => ipcRenderer.invoke('generation:source'),
  detectCharacterFace: sourceId => ipcRenderer.invoke('generation:detect-face', sourceId),
  generateCharacter: request => ipcRenderer.invoke('generation:create', request),
  generateCharacterMotions: request => ipcRenderer.invoke('generation:motions', request),
  discardCharacterDraft: id => ipcRenderer.invoke('generation:discard', id),
  cancelGeneration: () => ipcRenderer.invoke('generation:cancel'),
  onGenerationProgress: listener => {
    const receive = (_: unknown, progress: GenerationProgress) => listener(progress);
    ipcRenderer.on('generation:progress', receive);
    return () => ipcRenderer.removeListener('generation:progress', receive);
  },
  setCharacterPresence: (id, visible, effect) => ipcRenderer.invoke('character:presence', id, visible, effect),
  saveSettings: settings => ipcRenderer.invoke('settings:save', settings),
  publish: state => ipcRenderer.send('audio:state', state),
  browser: (action, value) => ipcRenderer.invoke('browser:action', action, value),
  browserBounds: bounds => ipcRenderer.send('browser:bounds', bounds),
  onBrowserStatus: listener => {
    const receive = (_: unknown, data: BrowserStatus) => listener(data);
    ipcRenderer.on('browser:status', receive);
    return () => ipcRenderer.removeListener('browser:status', receive);
  },
  copy: text => ipcRenderer.invoke('app:copy', text)
};
contextBridge.exposeInMainWorld('vox', api);
