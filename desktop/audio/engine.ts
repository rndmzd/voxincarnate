/// <reference types="vite/client" />
import type { Articulation, DetectorSettings } from '../shared';
import { EnvelopeDetector, type EnvelopeState } from './detector';
import { createLocalLipSync, type LocalLipSync } from './headaudio';
import workletUrl from './rms-worklet.js?url&no-inline';

export type AudioEngineState = EnvelopeState & { articulation?: Articulation; lipSyncError?: string };
type StateListener = (state: AudioEngineState) => void;
type EndListener = (reason: string) => void;

/** The trusted app renderer owns capture. No media samples cross Electron IPC. */
export class AudioEngine {
  private detector: EnvelopeDetector;
  private settings: DetectorSettings;
  private generation = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private sink?: GainNode;
  private lipSync?: LocalLipSync;
  private lipSyncError?: string;
  private startupAbort?: AbortController;
  private endedListeners: Array<{ track: MediaStreamTrack; listener: () => void }> = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private onState?: StateListener;

  constructor(settings: DetectorSettings) { this.settings = { ...settings }; this.detector = new EnvelopeDetector(settings); }

  setSettings(settings: DetectorSettings): void {
    this.settings = { ...settings };
    this.detector.update(settings);
    this.lipSync?.setSettings(settings);
  }

  async startDirect(deviceId: string, onState: StateListener, onEnded: EndListener): Promise<void> {
    return this.start(() => navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      },
      video: false
    }), onState, onEnded);
  }

  async startBrowser(onState: StateListener, onEnded: EndListener): Promise<void> {
    // Electron's main process restricts this request to the embedded assistant.
    // Keep the video track alive: Chromium may stop associated audio with it.
    return this.start(() => navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }), onState, onEnded);
  }

  async stop(): Promise<void> {
    ++this.generation;
    const listener = this.onState;
    this.onState = undefined;
    listener?.({ ...this.detector.reset(), articulation: { weights: { X: 1 }, audioTimeMs: 0 } });
    await this.release();
  }

  private async start(acquire: () => Promise<MediaStream>, onState: StateListener, onEnded: EndListener): Promise<void> {
    const canceled = () => new DOMException('Audio startup was canceled.', 'AbortError');
    const generation = ++this.generation;
    const previousListener = this.onState;
    this.onState = undefined;
    previousListener?.({ ...this.detector.reset(), articulation: { weights: { X: 1 }, audioTimeMs: 0 } });
    await this.release();
    if (generation !== this.generation) throw canceled();
    this.onState = onState;
    let latestEnvelope = this.detector.reset();
    onState({ ...latestEnvelope, articulation: { weights: { X: 1 }, audioTimeMs: 0 } });
    const startupAbort = new AbortController();
    this.startupAbort = startupAbort;
    try {
      const stream = await acquire();
      if (generation !== this.generation) {
        stream.getTracks().forEach(track => track.stop());
        throw canceled();
      }
      this.stream = stream;
      if (!stream.getAudioTracks().length) throw new Error('The selected source did not provide audio. Check source permissions and audio sharing.');
      const fail = (reason: string) => {
        if (generation !== this.generation) return;
        void this.stop();
        onEnded(reason);
      };
      for (const track of stream.getTracks()) {
        const listener = () => fail('Audio capture ended. Select the source and start again.');
        track.addEventListener('ended', listener);
        this.endedListeners.push({ track, listener });
      }
      const context = new AudioContext({ latencyHint: 'interactive' });
      this.context = context;
      await context.audioWorklet.addModule(workletUrl);
      if (generation !== this.generation) throw canceled();
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, 'vox-rms', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCountMode: 'max'
      });
      const sink = context.createGain();
      sink.gain.value = 0;
      this.source = source;
      this.worklet = worklet;
      this.sink = sink;
      let elapsedMs = 0;
      let audioTimeMs = 0;
      let lastMeasurement = performance.now();
      worklet.port.onmessage = event => {
        if (generation !== this.generation) return;
        const { rms, frames, sampleRate } = event.data ?? {};
        if (!Number.isFinite(rms) || !Number.isFinite(frames) || frames <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
        lastMeasurement = performance.now();
        const durationMs = frames / sampleRate * 1000;
        latestEnvelope = this.detector.processRms(rms, durationMs);
        elapsedMs += durationMs;
        audioTimeMs += durationMs;
        if (elapsedMs >= 1000 / 30) {
          elapsedMs %= 1000 / 30;
          onState({ ...latestEnvelope,
            ...(this.lipSync ? { articulation: this.lipSync.sample(audioTimeMs, latestEnvelope.speaking) } : {}),
            ...(this.lipSyncError ? { lipSyncError: this.lipSyncError } : {}) });
        }
      };
      worklet.onprocessorerror = () => fail('Audio processing stopped. Start capture again.');
      source.connect(worklet).connect(sink).connect(context.destination);
      const lipSyncFailed = (error: unknown) => {
        if (generation !== this.generation) return;
        this.lipSync?.dispose();
        this.lipSync = undefined;
        const detail = error instanceof Error ? error.message : 'The local lip-sync processor stopped.';
        this.lipSyncError = `Lip sync unavailable; using open/closed animation. ${detail}`;
        onState({ ...latestEnvelope, lipSyncError: this.lipSyncError });
      };
      try {
        const lipSync = await createLocalLipSync(context, source, startupAbort.signal, lipSyncFailed, this.settings);
        if (generation !== this.generation) { lipSync.dispose(); throw canceled(); }
        // Settings may have changed while the local worklet/model was loading.
        lipSync.setSettings(this.settings);
        this.lipSync = lipSync;
      } catch (error) {
        if (generation !== this.generation) throw canceled();
        lipSyncFailed(error);
      }
      await context.resume();
      if (generation !== this.generation) throw canceled();
      if (stream.getAudioTracks().some(track => track.readyState !== 'live')) throw new Error('The audio source ended before capture could start.');
      lastMeasurement = performance.now();
      this.heartbeat = setInterval(() => {
        if (performance.now() - lastMeasurement > 1000) fail('Audio capture stopped delivering data. Start capture again.');
      }, 250);
    } catch (error) {
      if (generation !== this.generation) throw canceled();
      await this.stop();
      throw error;
    }
  }

  private async release(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.startupAbort?.abort();
    this.startupAbort = undefined;
    this.lipSync?.dispose();
    this.lipSync = undefined;
    this.lipSyncError = undefined;
    const context = this.context;
    const stream = this.stream;
    const source = this.source;
    const worklet = this.worklet;
    const sink = this.sink;
    this.context = undefined;
    this.stream = undefined;
    this.source = undefined;
    this.worklet = undefined;
    this.sink = undefined;
    for (const { track, listener } of this.endedListeners) track.removeEventListener('ended', listener);
    this.endedListeners = [];
    if (worklet) {
      worklet.port.onmessage = null;
      worklet.onprocessorerror = null;
      worklet.port.close();
    }
    source?.disconnect();
    worklet?.disconnect();
    sink?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
  }
}
