/// <reference types="vite/client" />
import workletUrl from '../vendor/headaudio/headworklet.min.mjs?url&no-inline';
import modelUrl from '../vendor/headaudio/model-en-mixed.bin?url&no-inline';
import { ArticulationTracker } from './articulation';
import { DEFAULT_DETECTOR, type Articulation, type DetectorSettings } from '../shared';

interface Prototype {
  phoneme: string; group: number; viseme: number;
  mu: Float32Array; sigmaInvLower: Float32Array;
}

/** The pinned upstream model: 8-byte header, 12 means, 78 covariance entries. */
export function decodeHeadAudioModel(buffer: ArrayBuffer): Prototype[] {
  const recordBytes = 368;
  if (!buffer.byteLength || buffer.byteLength % recordBytes) throw new Error('The bundled lip-sync model is incomplete.');
  const model: Prototype[] = [];
  for (let offset = 0; offset < buffer.byteLength; offset += recordBytes) {
    const header = new DataView(buffer, offset, 8);
    const packed = header.getUint32(0);
    const first = packed >>> 16;
    const second = packed & 0xffff;
    const viseme = header.getUint8(7);
    const mu = new Float32Array(buffer, offset + 8, 12);
    const sigmaInvLower = new Float32Array(buffer, offset + 56, 78);
    if (viseme > 14 || !mu.every(Number.isFinite) || !sigmaInvLower.every(Number.isFinite)) throw new Error('The bundled lip-sync model contains invalid data.');
    model.push({ phoneme: String.fromCodePoint(first, ...(second ? [second] : [])), group: header.getUint8(5), viseme, mu, sigmaInvLower });
  }
  return model;
}

export interface LocalLipSync {
  sample(audioTimeMs: number, active?: boolean): Articulation;
  setSettings(settings: DetectorSettings): void;
  dispose(): void;
}

/** No outputs: raw speech is analyzed locally and can never be replayed here. */
export async function createLocalLipSync(
  context: AudioContext, source: MediaStreamAudioSourceNode, signal: AbortSignal,
  onError: (error: unknown) => void, settings: DetectorSettings = DEFAULT_DETECTOR
): Promise<LocalLipSync> {
  const check = () => { if (signal.aborted) throw new DOMException('Audio startup was canceled.', 'AbortError'); };
  check();
  await context.audioWorklet.addModule(workletUrl);
  check();
  const response = await fetch(modelUrl, { signal });
  if (!response.ok) throw new Error(`The bundled lip-sync model could not be read (${response.status}).`);
  const buffer = await response.arrayBuffer();
  check();
  const model = decodeHeadAudioModel(buffer);
  const node = new AudioWorkletNode(context, 'headworklet', {
    numberOfInputs: 1, numberOfOutputs: 0, outputChannelCount: [],
    channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    // The existing RMS detector owns gain/threshold/hold sensitivity. HeadAudio's
    // FFT-energy VAD uses different dB units, so it must not add a second gate.
    processorOptions: { frameEventsEnabled: false, featureEventsEnabled: false, visemeEventsEnabled: false },
    parameterData: { silMode: 0, vadMode: 0 }
  });
  const inferenceGain = context.createGain();
  const tracker = new ArticulationTracker();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    node.port.onmessage = null;
    node.onprocessorerror = null;
    try { source.disconnect(inferenceGain); } catch { /* The source may already be disconnected. */ }
    inferenceGain.disconnect();
    node.disconnect();
    node.port.close();
    tracker.reset();
  };
  const setSettings = (value: DetectorSettings) => {
    if (!disposed && !signal.aborted) {
      // Match EnvelopeDetector's bounded gain; no gain is applied to playback.
      inferenceGain.gain.value = Number.isFinite(value.gain) ? Math.min(32, Math.max(0, value.gain)) : 1;
    }
  };
  try {
    node.port.onmessage = event => { if (!disposed && !signal.aborted) tracker.receive(event.data, performance.now()); };
    node.onprocessorerror = event => { if (!disposed && !signal.aborted) { dispose(); onError(event); } };
    node.port.postMessage({ event: 'model', model }, [buffer]);
    check();
    setSettings(settings);
    source.connect(inferenceGain).connect(node);
  } catch (error) { dispose(); throw error; }
  return { sample: (audioTimeMs, active = true) => tracker.snapshot(audioTimeMs, performance.now(), active), setSettings, dispose };
}
