/**
 * The holes a decoder closes, found again from the packets - measured on Chrome 2026-11-06: an AAC
 * track missing 7 x 213 ms decoded 1.49 s short (docs/wiki/frontend/video-preparation.md).
 */
import { audioHoleMap, restoreAudioTimestamp } from './audioTimeline';

const F = 1024 / 48_000;
const chunks = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: start + i * F, duration: F }));

describe('audioHoleMap', () => {
  it('finds no hole in a contiguous track', () => {
    const map = audioHoleMap(
      chunks(5).map((c) => c.timestamp),
      chunks(5)
    );
    expect(map).toEqual({ kind: 'map', steps: [], holes: 0, holeSeconds: 0, overlaps: 0 });
  });

  it('places each hole where the decoder closed it, the offsets adding up', () => {
    const packets = [0, F, 2 * F + 0.2, 3 * F + 0.2, 4 * F + 0.5];
    const map = audioHoleMap(packets, chunks(5));
    if (map.kind !== 'map') throw new Error(map.kind);
    expect(map.holes).toBe(2);
    expect(map.holeSeconds).toBeCloseTo(0.5, 9);
    expect(map.steps.map((s) => [s.at, s.offset])).toEqual([
      [2 * F, expect.closeTo(0.2, 9)],
      [4 * F, expect.closeTo(0.5, 9)],
    ]);
    expect(restoreAudioTimestamp(map.steps, F)).toBeCloseTo(F, 9);
    expect(restoreAudioTimestamp(map.steps, 2 * F)).toBeCloseTo(2 * F + 0.2, 9);
    expect(restoreAudioTimestamp(map.steps, 4 * F)).toBeCloseTo(4 * F + 0.5, 9);
  });

  it('takes a constant decoder offset (Opus pre-skip) and sub-frame jitter for no hole', () => {
    const packets = [0, F + 0.003, 2 * F - 0.002, 3 * F];
    const map = audioHoleMap(packets, chunks(4, 0.0065));
    expect(map).toMatchObject({ kind: 'map', holes: 0 });
  });

  it('counts an overlap and never moves a sound earlier', () => {
    const packets = [0, F, F, 2 * F];
    const map = audioHoleMap(packets, chunks(4));
    expect(map).toMatchObject({ kind: 'map', holes: 0, overlaps: 2 });
  });

  it('refuses to pair a decoder that did not emit one chunk per packet', () => {
    expect(audioHoleMap([0, F, 2 * F], chunks(2))).toEqual({
      kind: 'unpaired',
      packets: 3,
      decoded: 2,
    });
  });
});
