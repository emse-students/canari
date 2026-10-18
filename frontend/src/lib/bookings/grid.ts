/**
 * THE BOOKER'S GRID AND PLANNING, AS PURE FUNCTIONS (WP-B5, D14).
 *
 * The server sends every unit of every resource with its state (`GET bookings/spaces/:id/slots`);
 * this module lays them out - the grid of one date (resources as columns, units as rows), the
 * planning (the next units one may book, per resource), the run of free steps a booking or a block
 * may cover - and says when a unit is outside the booking window. Times are read in the SPACE's
 * zone (D25: a traveller sees the space's time), with the platform's `Intl`, no library.
 *
 * The window check mirrors the server's `checkBookingWindow` so a unit that would be refused is not
 * offered; the server still applies it on every booking, never the screen alone.
 */
import { getLocale } from '$lib/paraglide/runtime';
import type { BookerSpace, ResourceSlots, SlotUnit } from './api';

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

const intlLocale = () => (getLocale() === 'en' ? 'en-US' : 'fr-FR');

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of an instant in a zone, as numbered parts (one formatter per zone). */
function wallParts(instantMs: number, zone: string): Record<string, number> {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    partsFormatters.set(zone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(instantMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return parts;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The local date `YYYY-MM-DD` of an instant in `zone`. */
export function localDateIn(instantMs: number, zone: string): string {
  const p = wallParts(instantMs, zone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The local wall time `HH:MM` of an instant in `zone`. */
export function localTimeIn(instantMs: number, zone: string): string {
  const p = wallParts(instantMs, zone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** `date` plus `days` calendar days (negative allowed), in plain calendar arithmetic. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * DAY_MS).toISOString().slice(0, 10);
}

/** A calendar date as the reader's language writes it: "lundi 2 novembre". */
export function formatDay(date: string, withYear = false): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(intlLocale(), {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** "10:00 - 11:30" in the space's zone. */
export function formatTimeRange(startMs: number, endMs: number, zone: string): string {
  return `${localTimeIn(startMs, zone)} - ${localTimeIn(endMs, zone)}`;
}

/** "lundi 2 novembre, 10:00 - 11:30" in the space's zone. */
export function formatBookingRange(startMs: number, endMs: number, zone: string): string {
  return `${formatDay(localDateIn(startMs, zone))}, ${formatTimeRange(startMs, endMs, zone)}`;
}

/**
 * Whether the device reads a different wall clock than the space at `nowMs`: the screen then names
 * the space's zone, so a traveller knows the times are the space's (D25).
 */
export function zoneDiffersFromDevice(zone: string, nowMs: number): boolean {
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!device || device === zone) return false;
  return (
    localDateIn(nowMs, zone) !== localDateIn(nowMs, device) ||
    localTimeIn(nowMs, zone) !== localTimeIn(nowMs, device)
  );
}

/** Why the booking window refuses a unit now - the server's codes (D26). */
export type WindowRefusal = 'not-open-yet' | 'started' | 'notice' | 'beyond-horizon';

/** The server's `checkBookingWindow`, for one start: the same order, the same codes. */
export function windowRefusal(
  space: Pick<BookerSpace, 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  startMs: number,
  nowMs: number
): WindowRefusal | null {
  if (space.opensAt && nowMs < Date.parse(space.opensAt)) return 'not-open-yet';
  if (startMs <= nowMs) return 'started';
  if (space.minNoticeMinutes && startMs < nowMs + space.minNoticeMinutes * MINUTE_MS) {
    return 'notice';
  }
  if (space.horizonDays && startMs > nowMs + space.horizonDays * DAY_MS) return 'beyond-horizon';
  return null;
}

/** One row of the grid of a date: one time range, and each resource's unit on it (or none). */
export interface GridRow {
  key: string;
  startMs: number;
  endMs: number;
  /** In the order of `resourceIds`; `null` where that resource has no unit on this range. */
  cells: (SlotUnit | null)[];
}

/**
 * The grid of one local date: every distinct range any resource offers that date, by start then
 * end, each with the unit of every resource. In slots mode two resources may offer different
 * ranges (D3): a resource without a unit on a row has an empty cell there.
 */
export function gridRows(
  resourceIds: readonly string[],
  slots: readonly ResourceSlots[],
  date: string
): GridRow[] {
  const byResource = new Map(slots.map((r) => [r.resourceId, r.units]));
  const rows = new Map<string, GridRow>();
  resourceIds.forEach((id, column) => {
    for (const unit of byResource.get(id) ?? []) {
      if (unit.date !== date) continue;
      const key = `${unit.startMs}-${unit.endMs}`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          startMs: unit.startMs,
          endMs: unit.endMs,
          cells: resourceIds.map(() => null),
        };
        rows.set(key, row);
      }
      row.cells[column] = unit;
    }
  });
  return [...rows.values()].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** A resource's units in time order (the server's order is by window; this does not rely on it). */
export function unitsInOrder(slots: readonly ResourceSlots[], resourceId: string): SlotUnit[] {
  const units = slots.find((r) => r.resourceId === resourceId)?.units ?? [];
  return [...units].sort((a, b) => a.startMs - b.startMs);
}

/**
 * The FREE units a range starting at `first` may cover, `first` included: each next unit starts
 * where the previous ends and is free, at most `limit` of them. One unit for a slot (D3: a slot is
 * booked whole), up to `maxSteps` for a booking in steps, and any length for a block. Empty when
 * `first` is not a free unit of `units`.
 */
export function freeRunFrom(
  units: readonly SlotUnit[],
  first: SlotUnit,
  limit: number
): SlotUnit[] {
  const start = units.findIndex((u) => u.startMs === first.startMs && u.endMs === first.endMs);
  if (start < 0 || units[start].state !== 'free') return [];
  const run = [units[start]];
  for (let i = start + 1; i < units.length && run.length < limit; i++) {
    const unit = units[i];
    if (unit.state !== 'free' || unit.startMs !== run[run.length - 1].endMs) break;
    run.push(unit);
  }
  return run;
}

/** How many units one booking may cover in this space: a whole slot, or 1..`maxSteps` steps. */
export function bookingUnitLimit(space: Pick<BookerSpace, 'slotMode' | 'maxSteps'>): number {
  return space.slotMode === 'slots' ? 1 : Math.max(1, space.maxSteps ?? 1);
}

/** One resource's next units a booker may take now - the planning view (D14). */
export interface PlanningEntry {
  resourceId: string;
  units: SlotUnit[];
}

/**
 * For each resource in order, its first `perResource` FREE units the booking window accepts now.
 * A resource with none is kept, empty, so the planning can say it is full rather than leave it out.
 */
export function planning(
  space: Pick<BookerSpace, 'opensAt' | 'minNoticeMinutes' | 'horizonDays'>,
  resourceIds: readonly string[],
  slots: readonly ResourceSlots[],
  nowMs: number,
  perResource: number
): PlanningEntry[] {
  return resourceIds.map((resourceId) => ({
    resourceId,
    units: unitsInOrder(slots, resourceId)
      .filter((u) => u.state === 'free' && windowRefusal(space, u.startMs, nowMs) === null)
      .slice(0, perResource),
  }));
}
