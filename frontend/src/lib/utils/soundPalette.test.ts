import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { GAZOUILLIS, SOUND_NAMES, scoreSound, soundDuration } from '$lib/utils/soundPalette';

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
