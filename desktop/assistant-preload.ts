import { contextBridge, ipcRenderer } from 'electron';
import { installAssistantAdapter, sendAssistantAdapterCommand, type AssistantAdapterCommand } from './browser-adapter';

const randomKey = (): string => Array.from(crypto.getRandomValues(new Uint32Array(4)), value => value.toString(16)).join('');
const controllerKey = `__voxincarnateAudio_${randomKey()}`;
const diagnosticsKey = randomKey();

function boundedStatus(value: unknown): {
  devices?: { deviceId: string; label: string }[];
  actualInput?: string;
  message?: string;
  error?: string;
} | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const source = value as Record<string, unknown>;
  const status: NonNullable<ReturnType<typeof boundedStatus>> = {};
  for (const field of ['actualInput', 'message', 'error'] as const) {
    if (typeof source[field] === 'string') status[field] = source[field].slice(0, field === 'actualInput' ? 256 : 768);
  }
  if (Array.isArray(source.devices)) {
    status.devices = source.devices.slice(0, 64).flatMap((device: unknown) => {
      if (!device || typeof device !== 'object') return [];
      const item = device as Record<string, unknown>;
      return typeof item.deviceId === 'string' && typeof item.label === 'string'
        ? [{ deviceId: item.deviceId.slice(0, 512), label: item.label.slice(0, 256) }]
        : [];
    });
  }
  return Object.keys(status).length ? status : undefined;
}

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const envelope: unknown = event.data;
  if (!envelope || typeof envelope !== 'object') return;
  const data = envelope as Record<string, unknown>;
  if (data.source !== 'voxincarnate-assistant-audio' || data.key !== diagnosticsKey) return;
  const status = boundedStatus(data.status);
  if (status) ipcRenderer.send('assistant:status', status);
});

try {
  const bootstrap: unknown = ipcRenderer.sendSync('assistant:bootstrap');
  const config = bootstrap && typeof bootstrap === 'object' ? bootstrap as Record<string, unknown> : {};
  const installed: unknown = contextBridge.executeInMainWorld({
    func: installAssistantAdapter,
    args: [{
      enabled: config.enabled === true,
      deviceId: typeof config.deviceId === 'string' ? config.deviceId.slice(0, 512) : '',
      controllerKey,
      diagnosticsKey
    }]
  });
  if (!installed || typeof installed !== 'object' || (installed as { ready?: unknown }).ready !== true) {
    const error = installed && typeof installed === 'object' && typeof (installed as { error?: unknown }).error === 'string'
      ? (installed as { error: string }).error.slice(0, 768)
      : 'The assistant microphone adapter did not initialize. Reload the page before enabling inputs.';
    ipcRenderer.send('assistant:status', { error });
  } else ipcRenderer.send('assistant:status', {
    message: 'Assistant microphone adapter ready. Enable / refresh to discover inputs.', error: ''
  });
  ipcRenderer.on('assistant:command', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') return;
    const candidate = value as Record<string, unknown>;
    let command: AssistantAdapterCommand;
    if (candidate.type === 'devices' || candidate.type === 'stop') command = { type: candidate.type };
    else if (candidate.type === 'input' && typeof candidate.deviceId === 'string' && candidate.deviceId.length <= 512) {
      command = { type: 'input', deviceId: candidate.deviceId };
    } else return;
    try {
      const delivered: unknown = contextBridge.executeInMainWorld({ func: sendAssistantAdapterCommand, args: [controllerKey, command] });
      if (delivered !== true) ipcRenderer.send('assistant:status', {
        error: 'The assistant microphone adapter is unavailable in this page. Reload the website, then enable / refresh inputs.'
      });
    } catch (error) {
      const name = error instanceof Error ? error.name.slice(0, 80) : 'Error';
      ipcRenderer.send('assistant:status', {
        error: `The assistant microphone command failed (${name}). Reload the website, then enable / refresh inputs.`
      });
    }
  });
} catch (error) {
  const name = error instanceof Error ? error.name.slice(0, 80) : 'Error';
  ipcRenderer.send('assistant:status', { error: `The assistant microphone adapter could not start (${name}). Reload the page before connecting voice.` });
}
