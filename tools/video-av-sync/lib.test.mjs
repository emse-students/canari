/**
 * The rig's arithmetic, without a browser: the schedule is the phone it claims to be, the onsets
 * and flashes are found where they are, and the verdict fails each way a drift can show - the END
 * included, which is where the production report saw it.
 */
import { describe, expect, it } from 'bun:test';
import { audioHoleCount, audioOnsets, frameSchedule, judge, OUTPUT_FPS } from './lib.mjs';

/** An output on the 30 fps grid, flashes on whole seconds shifted by `videoShift(k)`. */
function gridFrames(seconds, videoShift = () => 0) {
  const frames = [];
  for (let n = 0; n < seconds * OUTPUT_FPS; n++) {
    const t = n / OUTPUT_FPS;
    const k = Math.round(t);
    const flashAt = k + videoShift(k);
    const isFlash = Math.abs(t - flashAt) < 1 / (2 * OUTPUT_FPS);
    frames.push({ timestamp: t, duration: 1 / OUTPUT_FPS, luma: isFlash ? 235 : 32 });
  }
  return frames;
}

const beeps = (seconds, shift = () => 0) => Array.from({ length: seconds }, (_, k) => k + shift(k));

describe('frameSchedule', () => {
  it('drops frames and leaves quarter-second holes in vfr, never a flash', () => {
    const s = frameSchedule({ seconds: 14, fps: 30, mode: 'vfr' });
    const gaps = s.timestamps.slice(1).map((t, i) => t - s.timestamps[i]);
    expect(Math.max(...gaps)).toBeGreaterThan(0.25);
    expect(s.timestamps.length).toBeLessThan(14 * 30);
    expect(s.flash.filter(Boolean)).toHaveLength(14);
    for (const [i, t] of s.timestamps.entries()) {
      if (s.flash[i]) expect(Math.abs(t - Math.round(t))).toBeLessThan(0.007);
    }
  });

  it('is exact in cfr, and the same on every run', () => {
    const s = frameSchedule({ seconds: 2, fps: 24, mode: 'cfr' });
    expect(s.timestamps).toHaveLength(48);
    expect(s.timestamps[24]).toBe(1);
    expect(frameSchedule({ seconds: 14, fps: 30, mode: 'vfr' })).toEqual(
      frameSchedule({ seconds: 14, fps: 30, mode: 'vfr' })
    );
  });
});

describe('audioOnsets', () => {
  it('finds each beep once, at its own time', () => {
    const rate = 1000;
    const data = new Float32Array(3000);
    for (const start of [100, 1200, 2500]) data.fill(0.8, start, start + 30);
    expect(audioOnsets([{ timestamp: 2, data }], rate)).toEqual([2.1, 3.2, 4.5]);
  });
});

describe('judge', () => {
  it('passes an output in sync from the first second to the last', () => {
    const v = judge({ frames: gridFrames(14), onsets: beeps(14), audioEnd: 14.02, seconds: 14 });
    expect(v.failures).toEqual([]);
    expect(v.pairs.at(-1)).toMatchObject({ flash: 13, beep: 13, skewMs: 0 });
  });

  it('fails a picture that drifts late towards the end', () => {
    // 10 ms more per second: in sync at the start, 130 ms late on the last flash.
    const v = judge({
      frames: gridFrames(14, (k) => Math.round(k * 0.01 * OUTPUT_FPS) / OUTPUT_FPS),
      onsets: beeps(14),
      audioEnd: 14,
      seconds: 14,
    });
    expect(v.ok).toBe(false);
    expect(v.pairs[0].skewMs).toBe(0);
    expect(v.failures.some((f) => f.startsWith('second 13:'))).toBe(true);
  });

  it('fails a variable frame rate, a short video and an audio that outlasts it', () => {
    const frames = gridFrames(14).filter((_, i) => i % 7 !== 3);
    const v = judge({ frames, onsets: beeps(14), audioEnd: 14.5, seconds: 14 });
    expect(v.failures.some((f) => f.includes('not on the 30 fps grid'))).toBe(true);
    expect(v.failures.some((f) => f.startsWith('the audio ends'))).toBe(true);
    const short = judge({ frames: gridFrames(13), onsets: beeps(13), audioEnd: 13, seconds: 14 });
    expect(short.failures.some((f) => f.startsWith('the video ends'))).toBe(true);
  });
});

describe('audioHoleCount', () => {
  it('counts a packet that starts after the one before ends, and fails the verdict on it', () => {
    const f = 1024 / 48_000;
    expect(audioHoleCount([0, f, 2 * f, 3 * f + 0.2, 4 * f + 0.2])).toBe(1);
    const v = judge({
      frames: gridFrames(14),
      onsets: beeps(14),
      audioEnd: 14.02,
      seconds: 14,
      audioHoles: 1,
    });
    expect(v.failures).toEqual(['the audio has 1 hole(s) a player will close']);
  });

  it('counts no hole after an Opus first packet whose decoded chunk is short by its pre-skip', () => {
    // 20 ms packets; the first decodes 312 samples short, and the next packet still starts on time.
    expect(audioHoleCount([0, 0.02, 0.04, 0.06, 0.08])).toBe(0);
    expect(audioHoleCount([0])).toBe(0);
  });
});
