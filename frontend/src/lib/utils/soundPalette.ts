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
 * THE CALLER'S RINGBACK - "it is ringing at the other end", sung by a canary (owner, 2026-10-31:
 * *"mieux qu'une tonalite de telephone, dans le style d'un canari qui chante"*).
 *
 * ONE PHRASE, LOOPED WITH A PAUSE, like a phone's ringback (France: 1.5 s on, 3.5 s off): a soft
 * roll of six quick rising syllables - the canary's "tour" - then two slower falling whistles that
 * read as a question asked twice. It sits BELOW the notification trills (1350 to 2150 Hz, a soft
 * octave partial on the whistles only): it plays for up to the whole ring window against the ear,
 * so it must not be shrill, and the earpiece band carries it whole.
 *
 * NOT played by Web Audio: it is rendered offline by `tools/notification-sounds/render.mjs` into ONE
 * file of exactly {@link RINGBACK_PERIOD_S} seconds - the phrase, its small room, then silence - which
 * `utils/callRingback.ts` loops on an `<audio>` element. The loop is the element's own (`loop`), so no
 * timer paces it, and the pause is part of the file.
 */
export const RINGBACK_PHRASE: VoiceSpec[] = [
  ...[0, 0.075, 0.15, 0.225, 0.3, 0.375].flatMap((d, i) =>
    voice(d, {
      path: [
        [0, 1350 + (i % 2) * 60],
        [0.045, 1750 + (i % 2) * 60],
      ],
      dur: 0.065,
      vib: 18,
      vibHz: 28,
      peak: 0.1 + i * 0.006,
      send: 0.8,
    })
  ),
  ...[0.62, 0.95].flatMap((d) =>
    voice(d, {
      path: [
        [0, 2150],
        [0.24, 1600],
      ],
      dur: 0.28,
      vib: 22,
      vibHz: 24,
      peak: 0.13,
      partial: 2,
    })
  ),
];

/** One loop of the ringback, phrase and pause together, in seconds: the rendered file's length. */
export const RINGBACK_PERIOD_S = 4;

/** One beat of the incoming ring: 96 beats per minute. */
const RING_BEAT_S = 0.625;

/** A whistled note of the ring's lead canary: an upward scoop, a flutter, an octave partial. */
function ringNote(t: number, hz: number, beats: number, peak: number): VoiceSpec[] {
  return voice(t, {
    path: [
      [0, hz * 0.93],
      [0.045, hz],
      [beats * RING_BEAT_S * 0.85, hz * 0.985],
    ],
    dur: beats * RING_BEAT_S * 0.95,
    vib: 14,
    vibHz: 22,
    peak,
    partial: 2,
  });
}

/** A note of the second canary: the same whistle, softer, a slower flutter, no partial. */
function ringHarmony(t: number, hz: number, beats: number): VoiceSpec[] {
  return voice(t, {
    path: [
      [0, hz * 0.95],
      [0.05, hz],
      [beats * RING_BEAT_S * 0.85, hz * 0.99],
    ],
    dur: beats * RING_BEAT_S * 0.95,
    vib: 12,
    vibHz: 20,
    peak: 0.085,
  });
}

/**
 * The ring's melody, on the G major pentatonic: `[beat, lead hertz, harmony hertz, beats, peak]`.
 * The harmony is a diatonic third below, closing on the sixth below (B5 under G6) so the cadence
 * lands on a plain G chord.
 */
const RING_MELODY: [number, number, number, number, number][] = [
  [0, 1568, 1319, 0.5, 0.14], // G6 over E6
  [0.5, 1976, 1568, 0.5, 0.14], // B6 over G6
  [1, 2349, 1976, 1, 0.15], // D7 over B6
  [2, 1976, 1568, 0.5, 0.14], // B6 over G6
  [2.5, 1760, 1480, 1.25, 0.14], // A6 over F#6
  [4, 1568, 1319, 0.5, 0.14], // G6 over E6
  [4.5, 1976, 1568, 0.5, 0.14], // B6 over G6
  [5, 1760, 1480, 0.5, 0.14], // A6 over F#6
  [5.5, 1319, 1047, 0.5, 0.15], // E6 over C6
  [6, 1568, 988, 1.4, 0.14], // G6 over B5: the cadence
];

/**
 * THE INCOMING-CALL RING - "C1", two canaries singing (owner's choice, 2026-11-01, among five
 * candidates heard as renders): a melody on the G major pentatonic that rises to D7 through a little
 * grace trill and settles back on G6, and a second, softer canary a third below it, 15 ms late like
 * a real second bird, the pair resolving on a G chord. 96 BPM, 8 beats: ONE loop of exactly
 * {@link RING_PERIOD_S} seconds.
 *
 * Rendered offline by `tools/notification-sounds/render.mjs`, never hand-copied: the 5 s loop to
 * `res/raw/canari_ring.wav` (the Android `canari_calls_v2` channel and the native in-app ring) and
 * `static/sounds/canari_ring.wav` (the web in-app ring, looped on the tone output), and a 30 s
 * stretch of the same loop for CallKit's `ringtoneSound` on the iPhone. The render folds every
 * sample past the loop's end - the cadence's room tail - back onto its start, so `loop` playback
 * has no seam.
 */
export const RING_PHRASE: VoiceSpec[] = [
  ...RING_MELODY.flatMap(([beat, hz, , beats, peak]) =>
    ringNote(beat * RING_BEAT_S, hz, beats, peak)
  ),
  // The grace trill into D7: three tiny chirps just before the beat.
  ...[0, 0.04, 0.08].flatMap((d) =>
    voice(RING_BEAT_S - 0.12 + d, {
      path: [
        [0, 2200],
        [0.025, 2500],
      ],
      dur: 0.035,
      peak: 0.08,
    })
  ),
  ...RING_MELODY.flatMap(([beat, , hz, beats]) =>
    ringHarmony(beat * RING_BEAT_S + 0.015, hz, beats)
  ),
];

/** One loop of the incoming ring, in seconds: 8 beats at 96 BPM, the rendered loop's length. */
export const RING_PERIOD_S = 8 * RING_BEAT_S;

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
