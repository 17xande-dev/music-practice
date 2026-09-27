// The computer-keyboard fallback, for browsers without Web MIDI and for
// trying the site without an instrument. A-row keys play one octave of
// pitch classes (the usual DAW layout):
//
//    w e   t y u   o p
//   a s d f g h j k l ;
//   C D E F G A B C D E
//
// A laptop keyboard cannot span a four-octave scale or play two hands, so
// it plays *pitch classes* and the page picks the octave: each press sounds
// in the octave nearest the note(s) the exercise wants next. Right or wrong
// is still judged on the pitch class you chose.

const KEY_PC: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 0,
  KeyO: 1,
  KeyL: 2,
  KeyP: 3,
  Semicolon: 4,
};

export function pcForCode(code: string): number | undefined {
  return KEY_PC[code];
}

/**
 * The MIDI notes a press of pitch class `pc` stands for: one per target,
 * each in the octave nearest that target. With no targets (between runs)
 * it sounds around middle C.
 */
export function resolveOctave(
  pc: number,
  targets: readonly number[],
): number[] {
  const around = targets.length ? targets : [60];
  return around.map((t) => {
    const base = t - ((((t - pc) % 12) + 12) % 12); // highest note of pc at or below t
    return t - base <= 6 ? base : base + 12;
  });
}

export interface QwertyPress {
  code: string;
  pc: number;
  down: boolean;
  t: number;
}

/**
 * Listen for piano keys on the document. Ignores auto-repeat, modified
 * keys, and typing into form fields, so the tonic select still works with
 * the keyboard.
 */
export function listenQwerty(onPress: (p: QwertyPress) => void): () => void {
  const typing = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    return !!el &&
      (el.tagName === "INPUT" || el.tagName === "TEXTAREA" ||
        el.isContentEditable);
  };
  const handle = (down: boolean) => (e: KeyboardEvent) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    const pc = pcForCode(e.code);
    if (pc === undefined) return;
    e.preventDefault();
    onPress({ code: e.code, pc, down, t: e.timeStamp || performance.now() });
  };
  const kd = handle(true);
  const ku = handle(false);
  document.addEventListener("keydown", kd);
  document.addEventListener("keyup", ku);
  return () => {
    document.removeEventListener("keydown", kd);
    document.removeEventListener("keyup", ku);
  };
}

/**
 * A small Web Audio synth so computer-keyboard notes are audible. A MIDI
 * piano makes its own sound, so this only plays for QWERTY input.
 */
export class Synth {
  private ctx: AudioContext | null = null;
  private voices = new Map<number, { osc: OscillatorNode; gain: GainNode }>();

  private context(): AudioContext {
    // Created lazily: browsers only allow audio to start from a user
    // gesture, and a key press is one.
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  noteOn(midi: number) {
    this.noteOff(midi);
    const ctx = this.context();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.05, now + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    this.voices.set(midi, { osc, gain });
  }

  noteOff(midi: number) {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;
    const now = this.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    v.osc.stop(now + 0.2);
    this.voices.delete(midi);
  }
}
