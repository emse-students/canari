import { describe, expect, it } from 'vitest';
import { LoudnessMeter, isMediaLoudness, kWeightingFilters } from './loudnessMeter';

/** `seconds` of a sine at `dbfs` PEAK, `hz`, one plane. */
function sine(sampleRate: number, seconds: number, dbfs: number, hz = 1000): Float32Array {
  const n = Math.round(sampleRate * seconds);
  const a = Math.pow(10, dbfs / 20);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

/** Feeds `planes` in decoder-sized chunks (1024 frames, AAC's), as the seam does. */
function measure(sampleRate: number, planes: Float32Array[]) {
  const meter = new LoudnessMeter(sampleRate, planes.length);
  const frames = planes[0].length;
  for (let at = 0; at < frames; at += 1024) {
    const take = Math.min(1024, frames - at);
    meter.push(
      planes.map((p) => p.subarray(at, at + take)),
      take
    );
  }
  return meter.result();
}

describe('LoudnessMeter (ITU-R BS.1770-4)', () => {
  it('reproduces the standard 48 kHz K-weighting table', () => {
    const [shelf, highPass] = kWeightingFilters(48_000);
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 10);
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 10);
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 10);
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 10);
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 10);
    expect(highPass.a1).toBeCloseTo(-1.99004745483398, 10);
    expect(highPass.a2).toBeCloseTo(0.99007225036621, 10);
  });

  it.each([48_000, 44_100])('a 1 kHz sine at -20 dBFS reads -23 LUFS at %i Hz', (rate) => {
    const result = measure(rate, [sine(rate, 5, -20)]);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.integratedLufs - -23)).toBeLessThanOrEqual(0.1);
    expect(result!.samplePeakDbfs).toBeCloseTo(-20, 2);
  });

  it('sums the channels: the same sine on both of a stereo pair is 3 LU louder', () => {
    const tone = sine(48_000, 5, -20);
    const result = measure(48_000, [tone, tone]);
    expect(Math.abs(result!.integratedLufs - -19.99)).toBeLessThanOrEqual(0.1);
  });

  it('gates silence: digital zero has NO loudness', () => {
    expect(measure(48_000, [new Float32Array(48_000 * 3)])).toBeNull();
  });

  it('gates a signal under the absolute gate (-70 LUFS) out entirely', () => {
    expect(measure(48_000, [sine(48_000, 3, -80)])).toBeNull();
  });

  it('the relative gate leaves out a long quiet passage after a loud one', () => {
    // 5 s at -20 dBFS (-23 LUFS), then 5 s at -50 dBFS (-53 LUFS: kept by the absolute gate, but
    // more than 10 LU under the programme): the integrated loudness is the loud part's, give or take
    // the three blocks that straddle the change (-23.13). Without the relative gate it would be -26.
    const loud = sine(48_000, 5, -20);
    const quiet = sine(48_000, 5, -50);
    const both = new Float32Array(loud.length + quiet.length);
    both.set(loud);
    both.set(quiet, loud.length);
    const result = measure(48_000, [both]);
    expect(Math.abs(result!.integratedLufs - -23)).toBeLessThanOrEqual(0.2);
  });

  it('has no loudness under one 400 ms block', () => {
    expect(measure(48_000, [sine(48_000, 0.35, -20)])).toBeNull();
  });

  it('refuses a push with the wrong number of planes', () => {
    const meter = new LoudnessMeter(48_000, 2);
    expect(() => meter.push([new Float32Array(10)], 10)).toThrow(RangeError);
  });
});

describe('isMediaLoudness', () => {
  it('accepts a measurement and refuses what no real signal gives', () => {
    expect(isMediaLoudness({ integratedLufs: -18, samplePeakDbfs: -1 })).toBe(true);
    expect(isMediaLoudness(undefined)).toBe(false);
    expect(isMediaLoudness({ integratedLufs: -18 })).toBe(false);
    expect(isMediaLoudness({ integratedLufs: Number.NaN, samplePeakDbfs: -1 })).toBe(false);
    expect(isMediaLoudness({ integratedLufs: -80, samplePeakDbfs: -1 })).toBe(false);
    expect(isMediaLoudness({ integratedLufs: '-18', samplePeakDbfs: -1 })).toBe(false);
  });

  it('refuses a CRAFTED entry that would silence a video', () => {
    // Louder than any programme measures (0 LUFS is a full-scale signal).
    expect(isMediaLoudness({ integratedLufs: 29, samplePeakDbfs: 0 })).toBe(false);
    expect(isMediaLoudness({ integratedLufs: 0.5, samplePeakDbfs: 0 })).toBe(false);
    // A peak far UNDER the loudness: no signal makes that.
    expect(isMediaLoudness({ integratedLufs: -10, samplePeakDbfs: -30 })).toBe(false);
    // A sine's own shape (peak 3 dB over its loudness, and the stereo pair's +3) passes.
    expect(isMediaLoudness({ integratedLufs: -20, samplePeakDbfs: -20 })).toBe(true);
    expect(isMediaLoudness({ integratedLufs: 0, samplePeakDbfs: 0 })).toBe(true);
  });
});
