import { readFileSync } from 'fs';
import { join } from 'path';
import { bookingWindowRefusal } from './booking-window';

/** The server's half of `libs/contracts/booking-window.cases.json`; the screen reads the same. */
interface WindowCase {
  name: string;
  opensAt: number | null;
  notice: number | null;
  horizon: number | null;
  start: number;
  expected: string | null;
}

const CONTRACT = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', '..', '..', 'libs', 'contracts', 'booking-window.cases.json'),
    'utf8'
  )
) as { cases: WindowCase[] };

const NOW = Date.parse('2026-10-20T10:00:00Z');
const MIN = 60_000;

describe('bookingWindowRefusal follows the shared booking-window contract', () => {
  it('reads a contract with cases in it', () => {
    expect(CONTRACT.cases.length).toBeGreaterThan(0);
  });

  it.each(CONTRACT.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const window = {
      opensAtMs: c.opensAt === null ? null : NOW + c.opensAt * MIN,
      minNoticeMinutes: c.notice,
      horizonDays: c.horizon,
    };
    expect(bookingWindowRefusal(window, NOW + c.start * MIN, NOW)).toBe(c.expected);
  });
});
