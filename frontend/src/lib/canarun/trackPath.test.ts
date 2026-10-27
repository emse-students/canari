/** The trace drawing: bounded to its viewBox, whatever the peer sent. */
import { describe, expect, it } from 'vitest';
import { TRACK_VIEWBOX, trackPolylinePoints } from './trackPath';
import { RUN_BOUNDS } from './activity';
import { sampleRun } from '../../test/canarunFixture';

function parse(points: string): [number, number][] {
  return points.split(' ').map((p) => p.split(',').map(Number) as [number, number]);
}

describe('trackPolylinePoints', () => {
  it('draws nothing for fewer than two points', () => {
    expect(trackPolylinePoints([])).toBeNull();
    expect(trackPolylinePoints([4_543_400, 439_000])).toBeNull();
  });

  it('fits every vertex inside the viewBox padding', () => {
    const pts = parse(trackPolylinePoints(sampleRun().trackE5)!);
    expect(pts).toHaveLength(4);
    const { width, height, padding } = TRACK_VIEWBOX;
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(padding - 0.05);
      expect(x).toBeLessThanOrEqual(width - padding + 0.05);
      expect(y).toBeGreaterThanOrEqual(padding - 0.05);
      expect(y).toBeLessThanOrEqual(height - padding + 0.05);
    }
  });

  it('puts north at the top', () => {
    // Two points, the second further north: it must be drawn higher (smaller y).
    const [a, b] = parse(trackPolylinePoints([4_500_000, 400_000, 4_500_100, 400_000])!);
    expect(b[1]).toBeLessThan(a[1]);
  });

  it('draws a trace with no extent as a dot at the centre, never a division by zero', () => {
    const pts = parse(trackPolylinePoints([100, 100, 100, 100, 100, 100])!);
    for (const [x, y] of pts) {
      expect(x).toBe(TRACK_VIEWBOX.width / 2);
      expect(y).toBe(TRACK_VIEWBOX.height / 2);
    }
  });

  it('draws the largest trace allowed with exactly one vertex per point', () => {
    const track: number[] = [];
    for (let i = 0; i < RUN_BOUNDS.maxPoints; i++) track.push(4_500_000 + i * 7, 400_000 + i * 3);
    expect(parse(trackPolylinePoints(track)!)).toHaveLength(RUN_BOUNDS.maxPoints);
  });
});
