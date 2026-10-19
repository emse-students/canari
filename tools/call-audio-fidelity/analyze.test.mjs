/**
 * Self-test of the fidelity metrics: each KNOWN damage must move the metric that names it, and an
 * undamaged signal must score clean. Without this, a rig result is a number nobody can believe.
 * Run: `bun test tools/call-audio-fidelity`.
 */
import { describe, expect, it } from 'bun:test';
import { analyze, fft } from './analyze.mjs';
import { RATE, buildReference, quantised } from './signal.mjs';

const ref = quantised(buildReference({ seed: 1 }));

/** The reference looped `loops` times from an arbitrary phase - what a fake capture delivers. */
function looped(x, loops = 3, offset = 12_345) {
  const out = new Float64Array(x.length * loops);
  for (let i = 0; i < out.length; i++) out[i] = x[(i + offset) % x.length];
  return out;
}

/** Brick-wall low-pass of a periodic signal (one period, circular). */
function lowpass(x, hz) {
  let m = 1;
  while (m < x.length) m <<= 1;
  // Work on one period zero-padded is NOT circular; resample-free trick: use exact period length
  // via a direct DFT is too slow, so filter a padded copy and accept edge effects at the seam.
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  re.set(x);
  fft(re, im);
  const cut = Math.round((hz / RATE) * m);
  for (let k = cut; k <= m - cut; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fft(re, im, true);
  return re.subarray(0, x.length);
}

describe('analyze', () => {
  it('scores an untouched loop as clean', () => {
    const r = analyze(looped(ref), ref);
    expect(r.alignCorr).toBeGreaterThan(0.999);
    expect(r.segments.speech.snrDb).toBeGreaterThan(60);
    expect(r.segments.speech.lsdDb).toBeLessThan(0.5);
    expect(r.bandwidthHz).toBeGreaterThan(18_000);
    expect(r.dropouts.events).toBe(0);
    expect(r.driftMs).toBe(0);
    expect(r.clippedSamples).toBe(0);
  });

  it('reads a uniform gain as gain, not as damage', () => {
    const r = analyze(
      looped(ref).map((v) => v * 0.5),
      ref
    );
    expect(r.segments.speech.gainDb).toBeCloseTo(-6.02, 1);
    expect(r.segments.speech.snrDb).toBeGreaterThan(60);
    expect(Math.abs(r.segments.speech.hfLossDb)).toBeLessThan(0.1);
  });

  it('names a 4 kHz low-pass as a 4 kHz bandwidth and a lost high band', () => {
    const r = analyze(looped(lowpass(ref, 4000)), ref);
    expect(r.bandwidthHz).toBeGreaterThan(3500);
    expect(r.bandwidthHz).toBeLessThan(4600);
    expect(r.segments.speech.hfLossDb).toBeLessThan(-20);
    expect(r.tonesDb[5000]).toBeLessThan(-30);
  });

  it('counts a 60 ms hole in the speech as a dropout', () => {
    const y = looped(ref, 3, 0);
    // The analysis window starts at 14 s = 2 s into the second loop; speech runs 4-8 s of a loop.
    // The hole goes where the speech is loudest over 60 ms, so every frame of it is scored.
    const len = Math.round(0.06 * RATE);
    let bestAt = Math.round(4.0 * RATE);
    let bestE = 0;
    for (let s = Math.round(4.0 * RATE); s + len < 8 * RATE; s += 240) {
      let e = Infinity;
      for (let f = s; f < s + len; f += 480) {
        let fe = 0;
        for (let i = f; i < f + 480; i++) fe += ref[i] * ref[i];
        e = Math.min(e, fe);
      }
      if (e > bestE) {
        bestE = e;
        bestAt = s;
      }
    }
    const at = 12 * RATE + bestAt;
    for (let i = at; i < at + Math.round(0.06 * RATE); i++) y[i] = 0;
    const r = analyze(y, ref);
    expect(r.dropouts.events).toBeGreaterThanOrEqual(1);
    expect(r.dropouts.ms).toBeGreaterThanOrEqual(40);
  });

  it('follows a jitter buffer that removes time, and reports how much', () => {
    // 5 ms removed every 0.5 s - an accelerating NetEq - so the loop ends 120 ms early.
    const src = looped(ref, 3, 777);
    const kept = [];
    for (let i = 0; i < src.length; i++) {
      if (i % (RATE / 2) < 240) continue;
      kept.push(src[i]);
    }
    const r = analyze(Float64Array.from(kept), ref);
    expect(r.driftMs).toBeGreaterThan(100);
    expect(r.driftMs).toBeLessThan(135);
    expect(r.segments.sweep.lsdDb).toBeLessThan(3);
    expect(r.bandwidthHz).toBeGreaterThan(15_000);
  });

  it('tells formless noise from the reference: no block matches', () => {
    let s = 9;
    const noise = new Float64Array(ref.length * 3).map(() => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return (s / 2147483648 - 0.5) * 0.4;
    });
    const r = analyze(noise, ref);
    expect(r.matchCoef).toBeLessThan(0.3);
    expect(analyze(looped(ref), ref).matchCoef).toBeGreaterThan(0.99);
  });

  it('counts clipping', () => {
    const y = looped(ref).map((v) => Math.max(-1, Math.min(1, v * 4)));
    expect(analyze(y, ref).clippedSamples).toBeGreaterThan(100);
  });
});
