/**
 * THE APP'S ONE SOUND PALETTE - "A - Gazouillis" (chosen by the user, 2026-10-09): ONE distinct
 * sound per event, each a light canary-bird trill, high but soft.
 *
 * ONE DEFINITION, TWO RENDERERS. This file is pure data (no audio API), so both consumers read the
 * SAME numbers and cannot drift:
 *
 * - the in-app tones, which schedule these voices on the shared Web Audio output
 *   ({@link scoreSound}, played through `toneOutput.playTone`);
 * - the Android notification sounds, rendered offline from the very same specs by
 *   `tools/notification-sounds/render.mjs` into `res/raw/*.wav`.
 *
 * The parameters are a faithful port of the listening prototype the user chose from. A voice is an
 * oscillator whose pitch follows a path of `[seconds, hertz]` points joined by exponential ramps,
 * under an exponential attack/decay envelope, with optional vibrato (a low-frequency oscillator
 * adding `vib` hertz of swing at `vibHz`) and a sine partial an octave-ish above. `send` is the level
 * into the small bright room the Android files carry; the in-app tones are dry, because the output
 * is suspended the moment the last oscillator ends and a reverb tail would be cut.
 */

/** The five events that have a sound of their own. */
export type SoundName = 'message' | 'mention' | 'reaction' | 'send' | 'read';

/** One oscillator of a sound, `offset` seconds after the sound starts. */
export interface VoiceSpec {
  offset: number;
  /** Pitch points `[seconds after the voice starts, hertz]`, joined by exponential ramps. */
  path: [number, number][];
  type: OscillatorType;
  /** Gain at the top of the attack, before {@link MASTER_GAIN}. */
  peak: number;
  attack: number;
  /** Seconds until the envelope has decayed to silence. */
  dur: number;
  /** Vibrato swing in hertz, and its rate. 0 = none. */
  vib: number;
  vibHz: number;
  /** Level into the reverb (Android files only). */
  send: number;
}

/** What the prototype's volume slider was left at while it was listened to and chosen. */
export const MASTER_GAIN = 0.6;

export const SOUND_NAMES: readonly SoundName[] = ['message', 'mention', 'reaction', 'send', 'read'];

interface VoiceInput {
  path: [number, number][];
  dur: number;
  peak: number;
  vib?: number;
  vibHz?: number;
  partial?: number;
  send?: number;
}

/** Expands a prototype voice, its optional partial included, into flat specs. */
function voice(offset: number, v: VoiceInput): VoiceSpec[] {
  const attack = 0.012;
  const main: VoiceSpec = {
    offset,
    path: v.path,
    type: 'sine',
    peak: v.peak,
    attack,
    dur: v.dur,
    vib: v.vib ?? 0,
    vibHz: v.vibHz ?? 0,
    send: v.send ?? 1,
  };
  if (!v.partial) return [main];
  const partial: VoiceSpec = {
    offset,
    path: v.path.map(([t, h]) => [t, h * v.partial!]),
    type: 'sine',
    peak: v.peak * 0.35,
    attack,
    dur: v.dur * 0.7,
    vib: 0,
    vibHz: 0,
    send: 0.4,
  };
  return [main, partial];
}

/** The palette: every sound is a list of voices. */
export const GAZOUILLIS: Record<SoundName, VoiceSpec[]> = {
  message: [
    ...voice(0, {
      path: [
        [0, 1900],
        [0.07, 2500],
        [0.11, 2350],
      ],
      dur: 0.16,
      vib: 35,
      vibHz: 30,
      peak: 0.18,
    }),
    ...voice(0.13, {
      path: [
        [0, 2300],
        [0.08, 3000],
      ],
      dur: 0.16,
      vib: 40,
      vibHz: 32,
      peak: 0.16,
    }),
  ],
  mention: [
    ...[0, 0.1, 0.2].flatMap((d, i) =>
      voice(d, {
        path: [
          [0, 2100 + i * 250],
          [0.06, 2800 + i * 250],
          [0.09, 2600 + i * 250],
        ],
        dur: 0.12,
        vib: 30,
        vibHz: 34,
        peak: 0.18,
      })
    ),
    ...voice(0.34, {
      path: [
        [0, 3000],
        [0.2, 2200],
      ],
      dur: 0.28,
      vib: 25,
      vibHz: 26,
      peak: 0.14,
    }),
  ],
  reaction: voice(0, {
    path: [
      [0, 3200],
      [0.04, 3900],
    ],
    dur: 0.09,
    peak: 0.13,
  }),
  send: voice(0, {
    path: [
      [0, 1500],
      [0.08, 2300],
    ],
    dur: 0.12,
    peak: 0.12,
    send: 0.6,
  }),
  read: voice(0, {
    path: [
      [0, 2600],
      [0.06, 2000],
    ],
    dur: 0.09,
    peak: 0.1,
    send: 0.5,
  }),
};

/** Seconds from a sound's start to the end of its last voice. */
export function soundDuration(name: SoundName): number {
  return Math.max(...GAZOUILLIS[name].map((v) => v.offset + v.dur));
}

/**
 * Schedules one palette sound on `ctx` (dry) and returns EVERY oscillator it started - the vibrato
 * ones included, because `toneOutput` suspends the output on the `ended` of the last one counted.
 */
export function scoreSound(name: SoundName, ctx: AudioContext, startAt: number): OscillatorNode[] {
  const started: OscillatorNode[] = [];
  for (const v of GAZOUILLIS[name]) {
    const t0 = startAt + v.offset;
    const stopAt = t0 + v.dur + 0.05;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = v.type;
    osc.frequency.setValueAtTime(v.path[0][1], t0 + v.path[0][0]);
    for (let i = 1; i < v.path.length; i++) {
      osc.frequency.exponentialRampToValueAtTime(v.path[i][1], t0 + v.path[i][0]);
    }
    if (v.vib) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = v.vibHz;
      lfoGain.gain.value = v.vib;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(stopAt);
      started.push(lfo);
    }
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(v.peak * MASTER_GAIN, t0 + v.attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + v.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(stopAt);
    started.push(osc);
  }
  return started;
}
