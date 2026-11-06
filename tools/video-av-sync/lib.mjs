/**
 * The arithmetic of the A/V sync rig, with no browser in it, so it is tested by `bun test`.
 *
 * A source is made with a KNOWN sync: a white frame and a 1 kHz beep at every whole second. The rig
 * runs it through `prepareVideoForUpload` and reads the output back; these functions find the
 * flashes and the beeps again and say whether the two still meet - at the START and at the END,
 * where a drift shows (docs/wiki/frontend/video-preparation.md#constant-frame-rate).
 */

/** The output's frame rate, the Canari camera's (`VIDEO_FRAME_RATE` in `videoEncodingPlan.ts`). */
export const OUTPUT_FPS = 30;

/** How far a flash may sit from its beep: one output frame and a millisecond of rounding. */
export const SYNC_TOLERANCE_S = 1 / OUTPUT_FPS + 0.001;

/** A deterministic 0..1 generator (mulberry32), so a schedule is the same on every run. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The frame timestamps of a source, in seconds, and which of them are the flashes.
 *
 * - `cfr`: frame n at n / fps, exactly.
 * - `vfr`: what a phone that drops frames writes - a nominal `fps` grid, each frame jittered by up to
 *   +-6 ms, single frames dropped here and there and HOLES of 8 frames (a quarter of a second, the
 *   258 ms the production file showed) every 97 frames. The flash of second k is the first kept
 *   frame at or after k, never dropped, and sits up to 6 ms OFF the grid on purpose.
 *
 * @returns {{ timestamps: number[], durations: number[], flash: boolean[] }}
 */
export function frameSchedule({ seconds, fps, mode, seed = 7 }) {
  const rand = seeded(seed);
  const timestamps = [];
  const flash = [];
  const total = Math.round(seconds * fps);
  let nextFlash = 0;
  for (let n = 0; n < total; n++) {
    const nominal = n / fps;
    const isFlash = nominal >= nextFlash - 1e-9;
    if (isFlash) nextFlash += 1;
    if (mode === 'vfr' && !isFlash) {
      const inHole = n % 97 >= 40 && n % 97 < 48;
      const single = rand() < 0.12;
      if (inHole || single) continue;
    }
    const jitter = mode === 'vfr' && n > 0 ? (rand() - 0.5) * 0.012 : 0;
    timestamps.push(Math.max(0, nominal + jitter));
    flash.push(isFlash);
  }
  const durations = timestamps.map((t, i) =>
    i + 1 < timestamps.length ? timestamps[i + 1] - t : seconds - t
  );
  return { timestamps, durations, flash };
}

/** The beep's shape: 30 ms of 1 kHz at 0.8, over a faint noise floor so AAC spends real bits. */
export function beepSample(t, noise) {
  const inBeep = t - Math.floor(t) < 0.03;
  return (inBeep ? 0.8 * Math.sin(2 * Math.PI * 1000 * t) : 0) + 0.03 * (noise - 0.5);
}

/**
 * Onsets in a signal: the first sample louder than `threshold` after at least `quietS` of quiet.
 *
 * @param {Array<{ timestamp: number, data: Float32Array }>} chunks Decoded audio, in order, each with
 *   its presentation time - the timestamps a player schedules the samples at.
 */
export function audioOnsets(chunks, sampleRate, { threshold = 0.3, quietS = 0.5 } = {}) {
  const onsets = [];
  let lastLoud = -Infinity;
  for (const { timestamp, data } of chunks) {
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i]) <= threshold) continue;
      const t = timestamp + i / sampleRate;
      if (t - lastLoud >= quietS) onsets.push(t);
      lastLoud = t;
    }
  }
  return onsets;
}

/** The presentation times of the bright frames, one per run of bright frames. */
export function flashTimes(frames, { luma = 128, apartS = 0.5 } = {}) {
  const out = [];
  for (const f of frames) {
    if (f.luma < luma) continue;
    if (out.length && f.timestamp - out[out.length - 1] < apartS) continue;
    out.push(f.timestamp);
  }
  return out;
}

/**
 * The verdict on one output: every flash meets its beep within {@link SYNC_TOLERANCE_S}, the first
 * and the LAST included; the frames are on the constant grid; the two tracks end together.
 *
 * @param {{ frames: Array<{ timestamp: number, duration: number, luma: number }>,
 *           onsets: number[], audioEnd: number, seconds: number }} reading
 * @returns {{ ok: boolean, failures: string[], pairs: Array<{ flash: number, beep: number, skewMs: number }>,
 *             maxFrameGapMs: number, videoEnd: number, audioEnd: number }}
 */
export function judge({ frames, onsets, audioEnd, seconds }) {
  const failures = [];
  const flashes = flashTimes(frames);
  const pairs = [];
  for (let i = 0; i < Math.max(flashes.length, onsets.length); i++) {
    const flash = flashes[i];
    const beep = onsets[i];
    if (flash === undefined || beep === undefined) continue;
    pairs.push({ flash, beep, skewMs: Math.round((flash - beep) * 1000) });
  }
  const expected = Math.floor(seconds - 1e-9) + 1;
  if (flashes.length !== expected) failures.push(`${flashes.length} flashes, ${expected} expected`);
  if (onsets.length !== expected) failures.push(`${onsets.length} beeps, ${expected} expected`);
  for (const [i, p] of pairs.entries()) {
    if (Math.abs(p.flash - p.beep) > SYNC_TOLERANCE_S) {
      failures.push(`second ${i}: video ${p.skewMs} ms from audio`);
    }
  }
  let maxGap = 0;
  let offGrid = 0;
  for (let i = 1; i < frames.length; i++) {
    const gap = frames[i].timestamp - frames[i - 1].timestamp;
    maxGap = Math.max(maxGap, gap);
    if (Math.abs(gap - 1 / OUTPUT_FPS) <= 0.001) continue;
    if (offGrid++ === 0) {
      failures.push(
        `frame ${i} at ${frames[i].timestamp.toFixed(3)} s is ${(gap * 1000).toFixed(1)} ms after the one before, not on the ${OUTPUT_FPS} fps grid`
      );
    }
  }
  if (offGrid > 1) failures.push(`${offGrid} frames off the grid in all`);
  const last = frames[frames.length - 1];
  const videoEnd = last ? last.timestamp + last.duration : 0;
  if (Math.abs(videoEnd - seconds) > 1 / OUTPUT_FPS + 0.001) {
    failures.push(`the video ends at ${videoEnd.toFixed(3)} s, the source at ${seconds} s`);
  }
  if (Math.abs(audioEnd - videoEnd) > 0.05) {
    failures.push(
      `the audio ends at ${audioEnd.toFixed(3)} s, the video at ${videoEnd.toFixed(3)} s`
    );
  }
  return {
    ok: failures.length === 0,
    failures,
    pairs,
    maxFrameGapMs: Math.round(maxGap * 1000),
    videoEnd,
    audioEnd,
  };
}
