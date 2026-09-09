/**
 * The waveform is drawn from these numbers and from nothing else, so the properties that matter are
 * the ones a reader would notice being wrong: a strip that is not the width asked for, a loud half
 * drawn the same height as a silent one, and a tail that vanishes because the last bucket was
 * rounded away.
 */
import { describe, it, expect } from 'vitest';
import { computeWaveformPeaks, mixToMono } from './waveform';

/** `n` samples of a constant amplitude - a block of "sound" with a known RMS. */
function tone(n: number, amplitude: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => (i % 2 === 0 ? amplitude : -amplitude));
}

describe('computeWaveformPeaks', () => {
  it('returns exactly the number of bars asked for, whatever the sample count', () => {
    expect(computeWaveformPeaks(tone(10_000, 0.5), 40)).toHaveLength(40);
    expect(computeWaveformPeaks(tone(7, 0.5), 40)).toHaveLength(40);
  });

  it('normalises the loudest bucket to 1', () => {
    const samples = new Float32Array([...tone(100, 0.1), ...tone(100, 0.9)]);
    const peaks = computeWaveformPeaks(samples, 2);

    expect(peaks[1]).toBeCloseTo(1, 5);
    expect(peaks[0]).toBeCloseTo(0.1 / 0.9, 5);
  });

  it('draws silence as silence rather than dividing by zero', () => {
    // A muted microphone is a real recording, and it must produce a flat strip, not NaN bars.
    expect(computeWaveformPeaks(new Float32Array(500), 8)).toEqual(new Array(8).fill(0));
  });

  it('KEEPS THE TAIL, which a floored stride throws away', () => {
    // 105 samples over 10 buckets: a `Math.floor(10.5)` stride reads only the first 100 and the
    // last half-bucket - the end of the last word - is drawn as silence. Here the speech is ONLY
    // in that tail, so a floored implementation returns all zeros and this fails.
    const samples = new Float32Array(105);
    samples.fill(0.8, 100);
    const peaks = computeWaveformPeaks(samples, 10);

    expect(peaks[9]).toBeGreaterThan(0);
  });

  it('reads loudness rather than the single loudest sample', () => {
    // One click in an otherwise quiet bucket must not pin it to the same height as a bucket of
    // continuous speech. This is the whole reason it is RMS and not a peak: with a peak reduction
    // both buckets return 1 and the strip is a solid block.
    const clicked = new Float32Array(200);
    clicked[10] = 1;
    const speech = tone(200, 0.5);
    const peaks = computeWaveformPeaks(new Float32Array([...clicked, ...speech]), 2);

    expect(peaks[0]).toBeLessThan(peaks[1]);
  });

  it('has nothing to draw for an empty recording or a nonsense bar count', () => {
    expect(computeWaveformPeaks(new Float32Array(0), 40)).toEqual([]);
    expect(computeWaveformPeaks(tone(100, 0.5), 0)).toEqual([]);
    expect(computeWaveformPeaks(tone(100, 0.5), -3)).toEqual([]);
    expect(computeWaveformPeaks(tone(100, 0.5), 2.5)).toEqual([]);
  });
});

describe('mixToMono', () => {
  it('passes a mono buffer straight through, allocating nothing', () => {
    const data = tone(64, 0.4);
    const buffer = { numberOfChannels: 1, length: 64, getChannelData: () => data };

    expect(mixToMono(buffer)).toBe(data);
  });

  it('averages the channels, so a voice on one side alone is not drawn at full height', () => {
    const left = tone(4, 1);
    const right = new Float32Array(4);
    const buffer = {
      numberOfChannels: 2,
      length: 4,
      getChannelData: (c: number) => (c === 0 ? left : right),
    };

    expect(Array.from(mixToMono(buffer))).toEqual([0.5, -0.5, 0.5, -0.5]);
  });
});
