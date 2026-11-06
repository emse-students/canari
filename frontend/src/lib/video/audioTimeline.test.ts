/**
 * The holes a decoder closes, found again from the packets - measured on Chrome 2026-11-06: an AAC
 * track missing 7 x 213 ms decoded 1.49 s short (docs/wiki/frontend/video-preparation.md).
 */
import {
  audioHoleMap,
  HOLE_MIN_FRAMES,
  packetHoles,
  pairedPackets,
  restoreAudioTimestamp,
} from './audioTimeline';

const F = 1024 / 48_000;
const chunks = (n: number, start = 0) =>
  Array.from({ length: n }, (_, i) => ({ timestamp: start + i * F, duration: F }));
const times = (n: number) => chunks(n).map((c) => c.timestamp);

describe('packetHoles', () => {
  it('finds the holes from the packets alone, measured in the median packet length', () => {
    const packets = [...times(20), ...times(20).map((t) => t + 20 * F + 0.2)];
    const holes = packetHoles(packets);
    expect(holes.holes).toBe(1);
    expect(holes.holeSeconds).toBeCloseTo(0.2, 9);
    expect(holes.frame).toBeCloseTo(F, 9);
  });

  it('never calls a slow drift or a single late packet a hole', () => {
    // 0.5 % fast: 5 samples a packet, which a one-frame threshold would have cut into clicks.
    const drift = Array.from({ length: 2000 }, (_, i) => (i * 1029) / 48_000);
    expect(packetHoles(drift).holes).toBe(0);
    const late = times(10);
    late[5] += F * (HOLE_MIN_FRAMES - 0.5);
    expect(packetHoles(late).holes).toBe(0);
  });

  it('has nothing to say about fewer than two packets', () => {
    expect(packetHoles([0])).toEqual({ holes: 0, holeSeconds: 0, frame: 0 });
  });
});

describe('audioHoleMap', () => {
  it('finds no hole in a contiguous track', () => {
    expect(audioHoleMap(times(5), chunks(5))).toEqual({
      kind: 'map',
      steps: [],
      holes: 0,
      holeSeconds: 0,
      overlaps: 0,
    });
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

  it('finds no step for a decoder that keeps the packets timestamps (the encoder sees the gap)', () => {
    const packets = [0, F, 2 * F + 0.2];
    const kept = packets.map((timestamp) => ({ timestamp, duration: F }));
    expect(audioHoleMap(packets, kept)).toMatchObject({ kind: 'map', holes: 0 });
  });

  it('takes a constant decoder offset (Opus pre-skip) and sub-frame jitter for no hole', () => {
    const packets = [0, F + 0.003, 2 * F - 0.002, 3 * F];
    expect(audioHoleMap(packets, chunks(4, 0.0065))).toMatchObject({ kind: 'map', holes: 0 });
  });

  it('counts one overlap per run of early packets, and never moves a sound earlier', () => {
    const packets = [0, F, F, 2 * F, 4 * F, 4 * F, 5 * F];
    const map = audioHoleMap(packets, chunks(7));
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

describe('pairedPackets', () => {
  it('starts the pairing at the packet the decoder started from (a trimmed window)', () => {
    expect(pairedPackets(times(10), chunks(3, 4 * F), 6.5 * F)).toEqual(times(10).slice(4, 7));
    // Without an end, every packet from there on: a decoder that yields fewer is then unpaired.
    expect(pairedPackets(times(10), chunks(3, 4 * F), Infinity)).toEqual(times(10).slice(4));
  });

  it('pairs nothing when no packet is where the first chunk says', () => {
    expect(pairedPackets(times(10), chunks(3, 20 * F), Infinity)).toBeNull();
    expect(pairedPackets(times(10), [], Infinity)).toBeNull();
  });
});
