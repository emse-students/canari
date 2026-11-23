/**
 * Paris calendar time for the usage dashboard (docs/wiki/usage-dashboard.md, "Days, weeks and months
 * are Paris time"). The zone comes from `Intl` (the platform's tz database), never a fixed offset;
 * the gateway's EU-rule twin is held to the same cases by `libs/contracts/usage-dashboard.json`.
 *
 * A DAY IS A `YYYY-MM-DD` STRING once named: the arithmetic below (next day, week start, month start)
 * is calendar arithmetic on that string, done in UTC so no zone can shift it.
 */

const PARIS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Paris',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

/** The Paris calendar day and hour of an instant. */
export function parisSlot(at: Date): { day: string; hour: number } {
  const p = Object.fromEntries(PARIS.formatToParts(at).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

const DAY_MS = 86_400_000;
const toUtc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `day` moved by `n` calendar days. */
export function addDays(day: string, n: number): string {
  return fromUtc(toUtc(day) + n * DAY_MS);
}

/** 0 for Monday .. 6 for Sunday. */
export function weekdayIndex(day: string): number {
  return (new Date(toUtc(day)).getUTCDay() + 6) % 7;
}

/** The Monday that starts `day`'s ISO week. */
export function weekStart(day: string): string {
  return addDays(day, -weekdayIndex(day));
}

/** The first day of `day`'s calendar month. */
export function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

/** The first day of the month after the one `day` is in. */
export function nextMonthStart(day: string): string {
  const d = new Date(toUtc(monthStart(day)));
  d.setUTCMonth(d.getUTCMonth() + 1);
  return fromUtc(d.getTime());
}

/** Every day from `from` to `to`, both included (empty when `to` is before `from`). */
export function daysFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
