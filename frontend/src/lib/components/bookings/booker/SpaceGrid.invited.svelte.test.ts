// @vitest-environment happy-dom
/**
 * A BOOKING THE READER IS ONLY INVITED TO IS NOT "MA RESERVATION" (owner, 2026-11-10). Three cases
 * read from the payload (`mine`, `holderId` against the viewer): the reader's own booking says "Ma
 * reservation"; one they are invited to keeps the highlight but names the booker and says "Invite";
 * somebody else's names the booker, plainly.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import { weekLayout } from '$lib/bookings/grid';
import { setCurrentUserId } from '$lib/stores/userState.svelte';
import { m } from '$lib/paraglide/messages';
import SpaceGrid from './SpaceGrid.svelte';

vi.mock('$lib/components/shared/Avatar.svelte', () => ({ default: () => {} }));

const HOUR = 3_600_000;
const START = Date.parse('2026-11-02T08:00:00Z');
const resource = { id: 'r1', name: 'Salle' } as BookerResource;
const space = {
  name: 'Espace',
  slotMode: 'step',
  maxSteps: 1,
  timeZone: 'Europe/Paris',
  opensAt: null,
  minNoticeMinutes: 0,
  horizonDays: null,
} as unknown as BookerSpace;

const booked = (mine: boolean, holderId: string): SlotUnit =>
  ({
    date: '2026-11-02',
    startMs: START + 8 * HOUR,
    endMs: START + 9 * HOUR,
    state: 'booked',
    booking: { id: 'b1', mine, holderId, holderName: 'Louison CAMPISTRON' },
  }) as unknown as SlotUnit;

let app: ReturnType<typeof mount> | null = null;
afterEach(() => {
  if (app) unmount(app, { outro: false });
  app = null;
  document.body.innerHTML = '';
  setCurrentUserId(null);
  vi.restoreAllMocks();
});

async function draw(unit: SlotUnit) {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  setCurrentUserId('me');
  app = mount(SpaceGrid, {
    target: document.body,
    props: {
      space,
      resource,
      layout: weekLayout([unit], ['2026-11-02'], space, START),
      blockMode: false,
      nowMs: START,
      onPick: vi.fn(),
    },
  });
  flushSync();
  await tick();
  return document.querySelector<HTMLElement>('button[aria-label]');
}

describe('SpaceGrid - mine, invited, someone else', () => {
  it("says 'Ma reservation' for the reader's own booking, highlighted, with no mention", async () => {
    const cell = await draw(booked(true, 'me'));
    expect(cell?.textContent).toContain(m.bookings_cell_mine());
    expect(cell?.textContent).not.toContain(m.bookings_cell_invited());
    expect(cell?.innerHTML).toContain('bg-accent/25');
  });

  it("names the booker, keeps the highlight and says 'Invite' for an invited reader", async () => {
    const cell = await draw(booked(true, 'someone'));
    expect(cell?.textContent).not.toContain(m.bookings_cell_mine());
    expect(cell?.textContent).toContain('Louison CAMPISTRON');
    expect(cell?.querySelector('[data-invited]')?.textContent).toBe(m.bookings_cell_invited());
    expect(cell?.innerHTML).toContain('bg-accent/25');
  });

  it("names the booker plainly, unhighlighted, for someone else's booking", async () => {
    const cell = await draw(booked(false, 'someone'));
    expect(cell?.textContent).toContain('Louison CAMPISTRON');
    expect(cell?.textContent).not.toContain(m.bookings_cell_mine());
    expect(cell?.querySelector('[data-invited]')).toBeNull();
    expect(cell?.innerHTML).not.toContain('bg-accent/25');
  });
});
