/// <reference types="vite/client" />
import type { DetectorSettings } from '../shared';
import { EnvelopeDetector, type EnvelopeState } from './detector';
import workletUrl from './rms-worklet.js?url&no-inline';

type StateListener = (state: EnvelopeState) => void;
type EndListener = (reason: string) => void;

/** The trusted app renderer owns capture. No media samples cross Electron IPC. */
export class AudioEngine {
  private detector: EnvelopeDetector;
  private generation = 0;
  private stream?: MediaStream;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private worklet?: AudioWorkletNode;
  private sink?: GainNode;
  private endedListeners: Array<{ track: MediaStreamTrack; listener: () => void }> = [];
  private heartbeat?: ReturnType<typeof setInterval>;
  private onState?: StateListener;

  constructor(settings: DetectorSettings) { this.detector = new EnvelopeDetector(settings); }

  setSettings(settings: DetectorSettings): void { this.detector.update(settings); }

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
    listener?.(this.detector.reset());
    await this.release();
  }

  private async start(acquire: () => Promise<MediaStream>, onState: StateListener, onEnded: EndListener): Promise<void> {
    const canceled = () => new DOMException('Audio startup was canceled.', 'AbortError');
    const generation = ++this.generation;
    await this.release();
    if (generation !== this.generation) throw canceled();
    this.detector.reset();
    this.onState = onState;
    onState(this.detector.reset());
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
      let lastMeasurement = performance.now();
      worklet.port.onmessage = event => {
        if (generation !== this.generation) return;
        const { rms, frames, sampleRate } = event.data ?? {};
        if (!Number.isFinite(rms) || !Number.isFinite(frames) || frames <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
        lastMeasurement = performance.now();
        const durationMs = frames / sampleRate * 1000;
        const state = this.detector.processRms(rms, durationMs);
        elapsedMs += durationMs;
        if (elapsedMs >= 1000 / 30) {
          elapsedMs %= 1000 / 30;
          onState(state);
        }
      };
      worklet.onprocessorerror = () => fail('Audio processing stopped. Start capture again.');
      source.connect(worklet).connect(sink).connect(context.destination);
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
