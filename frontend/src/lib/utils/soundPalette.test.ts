import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  GAZOUILLIS,
  RING_PERIOD_S,
  RING_PHRASE,
  SOUND_NAMES,
  scoreSound,
  soundDuration,
} from '$lib/utils/soundPalette';

/** A recording AudioContext: counts oscillators and keeps their scheduled starts/stops. */
function fakeContext() {
  const oscillators: { start: number; stop: number; vibrato: boolean }[] = [];
  const param = () => ({
    value: 0,
    setValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  const ctx = {
    destination: {},
    createGain: () => ({ gain: param(), connect() {} }),
    createOscillator: () => {
      const o = {
        type: 'sine',
        frequency: param(),
        connect() {},
        start(t: number) {
          rec.start = t;
        },
        stop(t: number) {
          rec.stop = t;
        },
      };
      const rec = { start: 0, stop: 0, vibrato: false };
      oscillators.push(rec);
      return o;
    },
  };
  return { ctx: ctx as unknown as AudioContext, oscillators };
}

describe('the Gazouillis palette', () => {
  it('has five sounds, each different from every other', () => {
    expect(SOUND_NAMES).toHaveLength(5);
    const fingerprints = SOUND_NAMES.map((n) => JSON.stringify(GAZOUILLIS[n]));
    expect(new Set(fingerprints).size).toBe(5);
  });

  it('keeps the prototype numbers the user chose (message first voice, reaction)', () => {
    expect(GAZOUILLIS.message[0].path).toEqual([
      [0, 1900],
      [0.07, 2500],
      [0.11, 2350],
    ]);
    expect(GAZOUILLIS.message[0].vib).toBe(35);
    expect(GAZOUILLIS.reaction).toHaveLength(1);
    expect(GAZOUILLIS.reaction[0].peak).toBe(0.13);
    // The mention is three rising chirps and a falling tail.
    expect(GAZOUILLIS.mention).toHaveLength(4);
  });

  it('schedules every voice, vibrato oscillators included, so none outlives the output', () => {
    for (const name of SOUND_NAMES) {
      const { ctx, oscillators } = fakeContext();
      const started = scoreSound(name, ctx, 1);
      const vibratos = GAZOUILLIS[name].filter((v) => v.vib).length;
      expect(started, name).toHaveLength(GAZOUILLIS[name].length + vibratos);
      expect(started, name).toHaveLength(oscillators.length);
      const lastStop = Math.max(...oscillators.map((o) => o.stop));
      expect(lastStop, name).toBeCloseTo(1 + soundDuration(name) + 0.05, 6);
    }
  });
});

describe('the Android files rendered from the palette', () => {
  const raw = resolve(__dirname, '../../../src-tauri/gen/android/app/src/main/res/raw');
  it.each(['message', 'mention', 'reaction'])(
    'ships canari_gazouillis_%s.wav as a mono 16-bit WAV',
    (name) => {
      const file = resolve(raw, `canari_gazouillis_${name}.wav`);
      expect(existsSync(file), `run bun tools/notification-sounds/render.mjs`).toBe(true);
      const buf = readFileSync(file);
      expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
      expect(buf.readUInt16LE(22)).toBe(1);
      expect(buf.readUInt16LE(34)).toBe(16);
      const seconds = (buf.length - 44) / 2 / buf.readUInt32LE(24);
      expect(seconds).toBeGreaterThan(soundDuration(name as 'message'));
      expect(seconds).toBeLessThan(3);
    }
  );
});

describe('the incoming ring - C1, two canaries (owner, 2026-11-01)', () => {
  it('is one loop of 8 beats at 96 BPM, every voice inside it', () => {
    expect(RING_PERIOD_S).toBe(5);
    for (const v of RING_PHRASE) {
      expect(v.offset).toBeGreaterThanOrEqual(0);
      expect(v.offset + v.dur).toBeLessThanOrEqual(RING_PERIOD_S);
    }
  });

  it('keeps the numbers the owner heard: ten melody notes and their partials, a grace trill, ten harmony notes', () => {
    // Melody: ten notes, each with its octave partial; grace: three chirps; harmony: ten notes.
    expect(RING_PHRASE).toHaveLength(10 * 2 + 3 + 10);
    expect(RING_PHRASE[0].path).toEqual([
      [0, 1568 * 0.93],
      [0.045, 1568],
      [0.5 * 0.625 * 0.85, 1568 * 0.985],
    ]);
    // The second canary sings 15 ms late, a third below, and closes on B5 under the final G6.
    const harmony = RING_PHRASE.slice(23);
    expect(harmony[0].offset).toBeCloseTo(0.015, 9);
    expect(harmony[0].path[1][1]).toBe(1319);
    expect(harmony[9].path[1][1]).toBe(988);
    expect(harmony.every((v) => v.peak === 0.085)).toBe(true);
  });

  const read = (rel: string) => readFileSync(resolve(__dirname, rel));
  const raw = '../../../src-tauri/gen/android/app/src/main/res/raw/canari_ring.wav';
  const web = '../../../static/sounds/canari_ring.wav';
  const callkit = '../../../src-tauri/gen/apple/CallSounds/canari_ring_callkit.wav';

  it('ships the same rendered loop to Android and the web page, exactly one period long', () => {
    const a = read(raw);
    const b = read(web);
    expect(a.equals(b)).toBe(true);
    expect(a.readUInt16LE(22)).toBe(1);
    expect(a.readUInt16LE(34)).toBe(16);
    expect(a.readUInt32LE(40) / 2).toBe(Math.round(RING_PERIOD_S * a.readUInt32LE(24)));
  });

  it('gives CallKit whole loops of it, under 30 s', () => {
    const loop = read(raw);
    const long = read(callkit);
    const loopBytes = loop.readUInt32LE(40);
    const loops = long.readUInt32LE(40) / loopBytes;
    expect(Number.isInteger(loops)).toBe(true);
    expect(loops * RING_PERIOD_S).toBeLessThanOrEqual(30);
    for (let r = 0; r < loops; r++) {
      expect(
        long.subarray(44 + r * loopBytes, 44 + (r + 1) * loopBytes).equals(loop.subarray(44))
      ).toBe(true);
    }
  });
});
