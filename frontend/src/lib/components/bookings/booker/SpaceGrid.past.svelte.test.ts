// @vitest-environment happy-dom
/**
 * A UNIT THAT IS OVER IS DIMMED AND SAYS NOTHING (user, 2026-10-30: "Non reservable" repeated in
 * every cell of the week buried the cells still worth reading). A unit still to come that the
 * booking window refuses keeps its label, once per run; a screen reader still gets the state of both.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import { weekLayout } from '$lib/bookings/grid';
import { m } from '$lib/paraglide/messages';
import SpaceGrid from './SpaceGrid.svelte';

const HOUR = 3_600_000;
const START = Date.parse('2026-11-02T08:00:00Z');
const NOW = START + 2 * HOUR;
const resource = { id: 'r1', name: 'Salle' } as BookerResource;
// A 24 h notice: every unit from now to tomorrow is refused by the window on this clock.
const space = {
  name: 'Espace',
  slotMode: 'step',
  maxSteps: 1,
  timeZone: 'Europe/Paris',
  opensAt: null,
  minNoticeMinutes: 24 * 60,
  horizonDays: null,
} as unknown as BookerSpace;

const unit = (i: number): SlotUnit =>
  ({
    date: '2026-11-02',
    startMs: START + i * HOUR,
    endMs: START + (i + 1) * HOUR,
    state: 'free',
  }) as SlotUnit;

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function open(units: SlotUnit[]) {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  app = mount(SpaceGrid, {
    target: document.body,
    props: {
      space,
      resource,
      layout: weekLayout(units, ['2026-11-02'], space, NOW),
      mode: 'day',
      nowMs: NOW,
      onPick: vi.fn(),
    },
  });
  flushSync();
  await tick();
  return [...document.querySelectorAll<HTMLElement>('[data-cell]')];
}

describe('SpaceGrid - past and unavailable units', () => {
  it('writes no label in a past unit, and labels a coming refused run once', async () => {
    // 08-09 and 09-10 are over at NOW (10:00); 10-11, 11-12 and 12-13 are to come and refused.
    const cells = await open([0, 1, 2, 3, 4].map(unit));
    const written = cells.map((c) => c.textContent?.trim() ?? '');
    expect(written.slice(0, 2)).toEqual(['', '']);
    expect(written.slice(2)).toEqual([m.bookings_cell_closed(), '', '']);
  });

  it('still names the state of a past unit for a screen reader', async () => {
    const cells = await open([0, 1].map(unit));
    expect(cells[0].getAttribute('aria-label')).toContain(m.bookings_cell_closed());
  });
});
