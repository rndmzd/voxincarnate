import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, BrowserStatus } from './shared';
const api: DesktopApi = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  saveCharacter: character => ipcRenderer.invoke('character:save', character),
  importImages: (id, pose) => ipcRenderer.invoke('character:import', id, pose),
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
