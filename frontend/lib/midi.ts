// Web MIDI input: device discovery, hot-plug, and turning raw messages into
// NoteEvents. Only note on/off is read; everything else a piano sends
// (pedals, clock, active sensing) is ignored.

import type { NoteEvent } from "./engine.ts";

export type MidiState =
  /** Browser has no Web MIDI (Safari, older browsers). */
  | "unsupported"
  /** Web MIDI exists but only on https or localhost. */
  | "insecure"
  /** The visitor, or a policy, refused access. */
  | "denied"
  | "ready";

export interface MidiDevice {
  id: string;
  name: string;
}

/** The select value meaning "listen to every connected input". */
export const ALL_DEVICES = "*";

/**
 * Parse one MIDI message. Note-on with velocity 0 is a note-off by the MIDI
 * spec, and many keyboards send exactly that instead of 0x80.
 */
export function parseMessage(data: Uint8Array, t: number): NoteEvent | null {
  if (data.length < 3) return null;
  const kind = data[0] & 0xf0;
  const midi = data[1] & 0x7f;
  const velocity = data[2] & 0x7f;
  if (kind === 0x90 && velocity > 0) return { type: "on", midi, velocity, t };
  if (kind === 0x80 || kind === 0x90) {
    return { type: "off", midi, velocity: 0, t };
  }
  return null;
}

export class Midi {
  onNote: (ev: NoteEvent) => void = () => {};
  onDevices: (devices: MidiDevice[]) => void = () => {};

  private access: MIDIAccess | null = null;
  private selected: string = ALL_DEVICES;
  private readonly handler = (e: Event) => {
    const m = e as MIDIMessageEvent;
    if (!m.data) return;
    // timeStamp is on the performance.now() clock — the one the tempo
    // engine and metronome use — and records when the message arrived
    // rather than when this handler got round to running.
    const ev = parseMessage(m.data, m.timeStamp || performance.now());
    if (ev) this.onNote(ev);
  };

  async init(): Promise<MidiState> {
    if (!("requestMIDIAccess" in navigator)) {
      return globalThis.isSecureContext ? "unsupported" : "insecure";
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      return globalThis.isSecureContext ? "denied" : "insecure";
    }
    this.access.addEventListener("statechange", () => this.refresh());
    this.refresh();
    return "ready";
  }

  devices(): MidiDevice[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()]
      .filter((i) => i.state === "connected")
      .map((i) => ({
        id: i.id,
        name: i.name || i.manufacturer || "MIDI input",
      }));
  }

  /** Listen to one input by id, or ALL_DEVICES. */
  select(id: string) {
    this.selected = id;
    this.attach();
  }

  private refresh() {
    this.attach();
    this.onDevices(this.devices());
  }

  // Re-bind on every change: a piano switched off and on again comes back
  // as a new port object, and the old listener would be listening to
  // nothing.
  private attach() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.removeEventListener("midimessage", this.handler);
      if (this.selected === ALL_DEVICES || input.id === this.selected) {
        input.addEventListener("midimessage", this.handler);
      }
    }
  }
}
