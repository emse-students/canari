// @vitest-environment happy-dom
/** The phone's planning row of a booking the reader is invited to: booker's name and "Invite". */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import type { GridRun } from '$lib/bookings/gridRuns';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { m } from '$lib/paraglide/messages';
import PlanningList from './PlanningList.svelte';

vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

const HOUR = 3_600_000;
const START = Date.parse('2026-11-02T16:00:00Z');
const space = { timeZone: 'Europe/Paris', slotMode: 'step', maxSteps: 1 } as unknown as BookerSpace;
const resource = { id: 'r1', name: 'Salle' } as BookerResource;

const row = (mine: boolean, holderId: string): GridRun => {
  const unit = {
    date: '2026-11-02',
    startMs: START,
    endMs: START + HOUR,
    state: 'booked',
    booking: { id: 'b1', mine, holderId, holderName: 'Louison CAMPISTRON' },
  } as unknown as SlotUnit;
  return {
    kind: 'booked',
    first: 0,
    last: 0,
    startMs: START,
    endMs: START + HOUR,
    topMin: 0,
    heightMin: 60,
    lane: 0,
    lanes: 1,
    units: [unit],
  };
};

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  document.body.innerHTML = '';
  setCurrentUserId(null);
  vi.restoreAllMocks();
});

async function draw(run: GridRun) {
  setCurrentUserId('me');
  app = mount(PlanningList, {
    target: document.body,
    props: {
      days: [{ date: '2026-11-02', state: 'open', rows: [run] }],
      space,
      resource,
      nowMs: START - HOUR,
      lastRefusedStart: null,
      blockMode: false,
      focusDate: '2026-11-02',
      today: '2026-11-02',
      onOpen: vi.fn(),
      onFree: vi.fn(),
      onAdd: vi.fn(),
    },
  });
  flushSync();
  await tick();
  return document.querySelector<HTMLElement>('[data-row="booked"]');
}

describe('PlanningList - invited row', () => {
  it('names the booker with the Invite mention and the highlight', async () => {
    const r = await draw(row(true, 'other'));
    expect(r?.textContent).toContain('Louison CAMPISTRON');
    expect(r?.textContent).not.toContain(m.bookings_cell_mine());
    expect(r?.querySelector('[data-invited]')?.textContent).toBe(m.bookings_cell_invited());
    expect(r?.className).toContain('bg-accent/25');
  });

  it('own row: Ma reservation, no mention', async () => {
    const r = await draw(row(true, 'me'));
    expect(r?.textContent).toContain(m.bookings_cell_mine());
    expect(r?.querySelector('[data-invited]')).toBeNull();
  });

  it("someone else's row: no mention, no highlight", async () => {
    const r = await draw(row(false, 'other'));
    expect(r?.querySelector('[data-invited]')).toBeNull();
    expect(r?.className).not.toContain('bg-accent/25');
  });
});
