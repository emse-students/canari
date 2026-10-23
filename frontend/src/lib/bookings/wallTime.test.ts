import { describe, expect, it } from 'vitest';
import { instantOfWallTime, wallTimeIn } from './wallTime';
import { localDate } from './zonedTime';

const PARIS = 'Europe/Paris';
const at = (iso: string) => Date.parse(iso);

describe("a space's wall clock (D25)", () => {
  it("reads an instant on the space's clock, whatever the device's", () => {
    expect(wallTimeIn(at('2026-11-02T09:00:00Z'), PARIS)).toBe('2026-11-02T10:00');
    expect(wallTimeIn(at('2026-11-02T09:00:00Z'), 'Asia/Tokyo')).toBe('2026-11-02T18:00');
    expect(localDate(at('2026-11-02T23:30:00Z'), PARIS)).toBe('2026-11-03');
  });

  it('writes a wall time back to the same instant, round trip', () => {
    for (const iso of ['2026-11-02T09:00:00Z', '2026-07-14T20:15:00Z']) {
      expect(instantOfWallTime(wallTimeIn(at(iso), PARIS), PARIS)).toBe(at(iso));
    }
  });

  it('moves a wall time of the spring-forward gap forward, as the server does', () => {
    // 2026-03-29 02:30 does not exist in Paris: it is 03:30 CEST, 01:30Z.
    expect(instantOfWallTime('2026-03-29T02:30', PARIS)).toBe(at('2026-03-29T01:30:00Z'));
  });

  it('reads a wall time of the fall-back night as the EARLIER instant, as the server does', () => {
    // 2026-10-25 02:30 happens twice in Paris: first at 00:30Z (CEST).
    expect(instantOfWallTime('2026-10-25T02:30', PARIS)).toBe(at('2026-10-25T00:30:00Z'));
  });

  it('refuses what is not a wall time', () => {
    for (const bad of ['', '2026-02-30T10:00', '2026-11-02 10:00', '2026-11-02T24:00']) {
      expect(instantOfWallTime(bad, PARIS)).toBeNull();
    }
  });
});
