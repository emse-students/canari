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

async function open(units: SlotUnit[], onPick = vi.fn(), blockMode = false, days = ['2026-11-02']) {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  app = mount(SpaceGrid, {
    target: document.body,
    props: {
      space,
      resource,
      layout: weekLayout(units, days, space, NOW),
      blockMode,
      nowMs: NOW,
      onPick,
    },
  });
  flushSync();
  await tick();
  return [...document.querySelectorAll<HTMLElement>('[data-cell]')];
}

describe('SpaceGrid - past and unavailable units', () => {
  it('writes no label in a past unit, and labels a coming refused run once', async () => {
    // 08-09 and 09-10 are over at NOW (10:00); 10-11, 11-12 and 12-13 are to come and refused.
    await open([0, 1, 2, 3, 4].map(unit));
    // Two blocks: the past run (one block over its two units) says nothing, the coming refused run
    // (one block over its three units) says it once.
    const blocks = [...document.querySelectorAll<HTMLElement>('div[aria-hidden="true"].absolute')];
    expect(blocks.map((b) => b.textContent?.trim() ?? '')).toEqual(['', m.bookings_cell_closed()]);
  });

  it('does not offer a unit the booking window refuses: disabled, and a tap picks nothing', async () => {
    const onPick = vi.fn();
    // 10-11 is refused (24 h notice); 2026-11-03 11:00Z is past the notice and bookable.
    const later = {
      ...unit(0),
      date: '2026-11-03',
      startMs: NOW + 25 * HOUR,
      endMs: NOW + 26 * HOUR,
    } as SlotUnit;
    const cells = await open([unit(2), later], onPick, false, ['2026-11-02', '2026-11-03']);
    expect((cells[0] as HTMLButtonElement).disabled).toBe(true);
    cells[0].click();
    expect(onPick).not.toHaveBeenCalled();
    expect((cells[1] as HTMLButtonElement).disabled).toBe(false);
    cells[1].click();
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it("keeps a coming unit inside the notice a control on the organiser's block grid", async () => {
    const cells = await open([unit(3)], vi.fn(), true);
    expect((cells[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('reads a unit inside the notice as free for the organiser, as it acts on it (one rule)', async () => {
    // unit(3) is refused to a booker (24 h notice) but not to the organiser: the grid must not
    // draw it closed while the tap works.
    const booker = await open([unit(3)], vi.fn(), false);
    expect(booker[0].getAttribute('aria-label')).toContain(m.bookings_cell_closed());
    if (app) unmount(app, { outro: false });
    document.body.innerHTML = '';
    const organiser = await open([unit(3)], vi.fn(), true);
    expect(organiser[0].getAttribute('aria-label')).not.toContain(m.bookings_cell_closed());
    expect((organiser[0] as HTMLButtonElement).disabled).toBe(false);
  });

  it('offers the organiser no unit that has begun: the server freezes history', async () => {
    // unit(2) starts at NOW exactly; it is not "to come", so no block may start on it.
    const cells = await open([unit(2)], vi.fn(), true);
    expect((cells[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it('still names the state of a past unit for a screen reader', async () => {
    const cells = await open([0, 1].map(unit));
    expect(cells[0].getAttribute('aria-label')).toContain(m.bookings_cell_closed());
  });
});
