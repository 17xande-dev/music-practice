// The pitch tracker's audio-thread half: an AudioWorkletProcessor that keeps
// the last 2048 samples (~43 ms at 48 kHz, about three and a half periods of
// low E) and runs the pitch detector every 256 samples (~5 ms), posting one
// frame per hop to the page, which turns frames into notes.
//
// An AudioWorklet rather than polling an AnalyserNode from
// requestAnimationFrame: tempo grading needs onsets accurate to a few
// milliseconds, and rAF ticks only every ~16 ms with jitter on top. Here
// each frame is stamped with the audio clock time of its last sample.
//
// Loaded by URL (audioWorklet.addModule), so it is its own bundle entry;
// the bundle inlines the detector, and nothing in it allocates per frame.

import { onsetStrength } from "./lib/note_tracker.ts";
import { PitchDetector } from "./lib/pitch.ts";

// AudioWorkletGlobalScope, which Deno's libs don't describe.
declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

export const WINDOW = 2048;
export const HOP = 256;

export interface WorkletFrame {
  /** Audio-clock seconds of the window's last sample. */
  t: number;
  freq: number;
  clarity: number;
  rms: number;
  onset: number;
}

class PitchTracker extends AudioWorkletProcessor {
  private ring = new Float32Array(WINDOW);
  private window = new Float32Array(WINDOW);
  private write = 0;
  private filled = 0;
  private sinceHop = 0;
  private detector = new PitchDetector(WINDOW, sampleRate, {
    minHz: 70,
    maxHz: 1400,
    minRmsDb: -70,
  });

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    if (!input) return true; // nothing connected yet; keep the node alive
    for (let i = 0; i < input.length; i++) {
      this.ring[this.write] = input[i];
      this.write = (this.write + 1) % WINDOW;
      if (this.filled < WINDOW) this.filled++;
      if (++this.sinceHop < HOP || this.filled < WINDOW) continue;
      this.sinceHop = 0;
      // Unroll the ring, oldest sample first.
      const head = WINDOW - this.write;
      this.window.set(this.ring.subarray(this.write), 0);
      this.window.set(this.ring.subarray(0, this.write), head);
      const f = this.detector.detect(this.window);
      const frame: WorkletFrame = {
        t: currentTime + (i + 1) / sampleRate,
        freq: f.freq,
        clarity: f.clarity,
        rms: f.rms,
        onset: onsetStrength(this.window),
      };
      this.port.postMessage(frame);
    }
    return true;
  }
}

registerProcessor("pitch-tracker", PitchTracker);
