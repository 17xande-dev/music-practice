// Guitar input from an audio interface (a Rocksmith Real Tone cable, say):
// device choice, permission, the pitch-tracking AudioWorklet, and the note
// tracker that turns its frames into the NoteEvents the rest of the page
// already understands.
//
// The browser's voice processing is switched off: echo cancellation, noise
// suppression and automatic gain all distort a DI guitar signal and add
// latency (the old practice.guitar project found the same).

import type { NoteEvent } from "./engine.ts";
import { NoteTracker, type TimedFrame } from "./note_tracker.ts";
import { freqToMidi } from "./pitch.ts";

export type AudioState = "unsupported" | "insecure" | "denied" | "nodevice" | "ready";

export interface AudioDevice {
  id: string;
  label: string;
}

/** What the tuner readout shows: the detected note, its tuning, the level. */
export interface Reading {
  midi: number | null;
  cents: number;
  rms: number;
}

/** Device labels that mark a guitar interface, preferred when present. */
const GUITAR_LABELS = /rocksmith|guitar|real ?tone|hi-z|instrument/i;

interface WorkletMessage {
  t: number;
  freq: number;
  clarity: number;
  rms: number;
  onset: number;
}

export class AudioInput {
  onNote: (ev: NoteEvent) => void = () => {};
  onReading: (r: Reading) => void = () => {};
  onDevices: (devices: AudioDevice[]) => void = () => {};

  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private source: AudioNode | null = null;
  private stream: MediaStream | null = null;
  private tracker = new NoteTracker();
  private inputLatencyMs = 0;
  private listening = false;

  constructor(private readonly workletUrl: string) {
    navigator.mediaDevices?.addEventListener?.("devicechange", () => {
      void this.devices().then((d) => this.onDevices(d));
    });
  }

  /** Audio inputs, guitar interfaces first. Labels are empty before permission. */
  async devices(): Promise<AudioDevice[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === "audioinput")
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` }))
      .sort((a, b) => Number(GUITAR_LABELS.test(b.label)) - Number(GUITAR_LABELS.test(a.label)));
  }

  /**
   * Start listening, on `deviceId` if given, otherwise on a guitar interface
   * if one is connected, otherwise the default input. The first call asks
   * for permission; device labels only become readable after it.
   */
  async start(deviceId?: string): Promise<AudioState> {
    if (!globalThis.isSecureContext) return "insecure";
    if (!navigator.mediaDevices?.getUserMedia || !("AudioWorkletNode" in globalThis)) {
      return "unsupported";
    }
    try {
      await this.open(deviceId);
      if (!deviceId) {
        // Permission granted, labels readable: switch to a guitar interface
        // if the default input isn't one.
        const guitar = (await this.devices()).find((d) => GUITAR_LABELS.test(d.label));
        const current = this.stream?.getAudioTracks()[0]?.getSettings().deviceId;
        if (guitar && guitar.id !== current) await this.open(guitar.id);
      }
      this.onDevices(await this.devices());
      return "ready";
    } catch (e) {
      const name = (e as DOMException)?.name;
      if (name === "NotAllowedError" || name === "SecurityError") return "denied";
      if (name === "NotFoundError" || name === "OverconstrainedError") return "nodevice";
      throw e;
    }
  }

  /** The device currently in use. */
  get deviceId(): string | undefined {
    return this.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.source?.disconnect();
    this.source = null;
    for (const ev of this.tracker.flush(performance.now())) this.onNote(ev);
    this.listening = false;
  }

  /**
   * Feed rendered audio through the same worklet and tracker instead of the
   * microphone: the practice page's test hook uses it to drive the whole
   * pipeline without a guitar.
   */
  async play(samples: Float32Array, sampleRate: number): Promise<void> {
    await this.ensureGraph();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") await ctx.resume();
    this.source?.disconnect();
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(new Float32Array(samples), 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.node!);
    this.source = src;
    this.listening = true;
    src.start();
    await new Promise<void>((resolve) => (src.onended = () => resolve()));
  }

  private async open(deviceId?: string) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    await this.ensureGraph();
    const ctx = this.ctx!;
    if (ctx.state === "suspended") await ctx.resume();
    const track = this.stream.getAudioTracks()[0];
    // Where the browser reports input latency, account for it; the user's
    // latency offset covers whatever it doesn't.
    const latency = (track?.getSettings() as MediaTrackSettings & { latency?: number }).latency;
    this.inputLatencyMs = typeof latency === "number" ? latency * 1000 : 0;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.node!);
    this.listening = true;
  }

  private async ensureGraph() {
    if (this.node) return;
    this.ctx ??= new AudioContext({ latencyHint: "interactive" });
    await this.ctx.audioWorklet.addModule(this.workletUrl);
    this.node = new AudioWorkletNode(this.ctx, "pitch-tracker", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
    });
    // A silent path to the destination keeps the node processing in every
    // browser; some don't run a node whose output goes nowhere.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<WorkletMessage>) => this.frame(e.data);
  }

  private frame(m: WorkletMessage) {
    if (!this.listening) return;
    const f: TimedFrame = { ...m, t: this.toPerf(m.t) - this.inputLatencyMs };
    for (const ev of this.tracker.push(f)) this.onNote(ev);
    const midi = m.freq > 0 && m.clarity >= 0.9 ? freqToMidi(m.freq) : null;
    this.onReading({
      midi: midi === null ? null : Math.round(midi),
      cents: midi === null ? 0 : Math.round((midi - Math.round(midi)) * 100),
      rms: m.rms,
    });
  }

  /** Audio-clock seconds → performance.now() milliseconds. */
  private toPerf(audioTime: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp();
    if (
      ts.contextTime !== undefined && ts.performanceTime !== undefined && ts.performanceTime > 0
    ) {
      return ts.performanceTime + (audioTime - ts.contextTime) * 1000;
    }
    return performance.now() + (audioTime - ctx.currentTime) * 1000;
  }
}
