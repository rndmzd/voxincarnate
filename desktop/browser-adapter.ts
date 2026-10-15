export interface AssistantAdapterConfiguration {
  enabled: boolean;
  deviceId: string;
  controllerKey: string;
  diagnosticsKey: string;
}

export type AssistantAdapterCommand =
  | { type: 'devices' }
  | { type: 'input'; deviceId: string }
  | { type: 'stop' };

/**
 * Runs at document start in the assistant's main world. Keep every runtime
 * dependency inside this function: Electron serializes it across the boundary.
 * This adapts ordinary getUserMedia calls; it is not a security boundary against
 * the remote page, which still owns its JavaScript and browser media APIs.
 */
export function installAssistantAdapter(configuration: AssistantAdapterConfiguration): { ready: boolean; error?: string } {
  function report(status: {
    devices?: { deviceId: string; label: string }[];
    actualInput?: string;
    message?: string;
    error?: string;
  }): void {
    window.postMessage({
      source: 'voxincarnate-assistant-audio',
      key: configuration.diagnosticsKey,
      status
    }, window.location.origin);
  }

  const media = navigator.mediaDevices;
  if (!media?.getUserMedia || !media.enumerateDevices) {
    const error = `The assistant website did not expose microphone access (secure context: ${window.isSecureContext ? 'yes' : 'no'}). Reload the HTTPS website before enabling inputs.`;
    report({ error });
    return { ready: false, error };
  }
  const originalGetUserMedia = media.getUserMedia.bind(media);
  const streams = new Set<MediaStream>();
  let enabled = configuration.enabled;
  let selectedId = configuration.deviceId;
  let generation = 0;
  let deviceListGeneration = 0;

  function errorText(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 768) : 'Audio input failed.';
  }

  function stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop();
    streams.delete(stream);
  }

  function stopAll(): void {
    for (const stream of streams) stopStream(stream);
    report({ actualInput: '', message: 'Assistant microphone stopped.' });
  }

  async function listDevices(requestLabels: boolean): Promise<void> {
    const listGeneration = ++deviceListGeneration;
    if (requestLabels) report({ message: 'Checking assistant microphones…', error: '' });
    try {
      let devices = await media.enumerateDevices();
      if (listGeneration !== deviceListGeneration) return;
      const inputs = devices.filter(device => device.kind === 'audioinput');
      // Only the explicit Devices command can briefly open a microphone to
      // obtain permission/labels. A devicechange event never starts capture.
      if (requestLabels && (!inputs.length || inputs.every(device => !device.label))) {
        report({ message: 'Requesting microphone permission to identify assistant inputs…' });
        const temporary = await originalGetUserMedia({ audio: true, video: false });
        stopStream(temporary);
        if (listGeneration !== deviceListGeneration) return;
        devices = await media.enumerateDevices();
      }
      if (listGeneration !== deviceListGeneration) return;
      const available = devices
        // Chromium aliases resolve to a physical ID in track settings. List
        // concrete devices so the exact selection can be verified honestly.
        .filter(device => device.kind === 'audioinput' && device.deviceId !== 'default' && device.deviceId !== 'communications')
        .slice(0, 64)
        .map(device => ({ deviceId: device.deviceId.slice(0, 512), label: device.label.slice(0, 256) }));
      if (!available.length) {
        report({ devices: [], message: 'No assistant microphones available.',
          error: 'The assistant browser found no selectable microphone. Check Windows microphone privacy permissions and connected audio inputs, then enable / refresh again.' });
      } else {
        report({ devices: available,
          message: `Found ${available.length} assistant audio input${available.length === 1 ? '' : 's'}. Choose a microphone, save, then capture assistant audio.`,
          ...(requestLabels ? { error: '' } : {}) });
      }
    } catch (error) {
      if (listGeneration === deviceListGeneration) report({ devices: [], message: 'Assistant microphone discovery failed.', error: errorText(error) });
    }
  }

  media.getUserMedia = async function getUserMedia(constraints?: MediaStreamConstraints): Promise<MediaStream> {
    if (!constraints?.audio) return originalGetUserMedia(constraints);
    if (!enabled) {
      const error = new DOMException('Start Browser mode and select its microphone before connecting voice.', 'NotAllowedError');
      report({ error: error.message });
      throw error;
    }
    if (!selectedId) {
      const error = new DOMException('Select a microphone from this assistant page\'s device list.', 'NotFoundError');
      report({ error: error.message });
      throw error;
    }
    const requestGeneration = generation;
    const requestedId = selectedId;
    const audio = typeof constraints.audio === 'object' ? constraints.audio : {};
    let stream: MediaStream | undefined;
    try {
      stream = await originalGetUserMedia({ ...constraints, audio: { ...audio, deviceId: { exact: requestedId } } });
      // The site may resolve a pending request after the user has stopped or
      // changed inputs. Never allow that stale stream to keep recording.
      if (!enabled || generation !== requestGeneration) {
        throw new DOMException('Microphone selection changed while connecting. Reconnect voice.', 'AbortError');
      }
      const tracks = stream.getAudioTracks();
      if (!tracks.length || tracks.some(track => track.getSettings().deviceId !== requestedId)) {
        throw new DOMException('The browser did not confirm the selected microphone. Voice capture was stopped.', 'NotReadableError');
      }
      streams.add(stream);
      const activeStream = stream;
      for (const track of stream.getTracks()) {
        track.addEventListener('ended', () => {
          if (activeStream.getTracks().every(item => item.readyState === 'ended')) {
            streams.delete(activeStream);
            if (!streams.size) report({ actualInput: '', message: 'Assistant microphone disconnected.' });
          }
        }, { once: true });
      }
      report({ actualInput: (tracks[0].label || requestedId).slice(0, 256), message: 'Selected assistant microphone verified.', error: '' });
      return stream;
    } catch (error) {
      if (stream) stopStream(stream);
      report({ error: errorText(error) });
      throw error;
    }
  };

  Object.defineProperty(window, configuration.controllerKey, {
    configurable: false, enumerable: false, writable: false,
    value(command: AssistantAdapterCommand): void {
      if (!command || typeof command !== 'object') return;
      if (command.type === 'devices') {
        void listDevices(true);
      } else if (command.type === 'input' && typeof command.deviceId === 'string' && command.deviceId.length <= 512) {
        generation++;
        deviceListGeneration++;
        stopAll();
        selectedId = command.deviceId;
        enabled = true;
        report({ message: selectedId ? 'Microphone selected. Reconnect the assistant voice session.' : 'Choose an assistant microphone before connecting voice.', error: '' });
      } else if (command.type === 'stop') {
        enabled = false;
        generation++;
        deviceListGeneration++;
        stopAll();
      }
    }
  });
  media.addEventListener('devicechange', () => { void listDevices(false); });
  report({ message: 'Assistant microphone adapter ready. Enable / refresh to discover inputs.', error: '' });
  return { ready: true };
}

/** Also serialized into the page; it exposes no native API. */
export function sendAssistantAdapterCommand(controllerKey: string, command: AssistantAdapterCommand): boolean {
  const controller = (window as unknown as Record<string, unknown>)[controllerKey];
  if (typeof controller !== 'function') return false;
  controller(command);
  return true;
}
