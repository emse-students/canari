// @vitest-environment happy-dom
/**
 * THE DASHBOARD'S GRID IS QUIET WHERE NOTHING IS TAKEN: in block mode a free unit is empty ground
 * with no "Libre" word and no green, while a blocked one keeps its reason; the booker's grid keeps
 * its green "Libre". The key above the grid (`WeekBar`) draws the same, per mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import { weekLayout } from '$lib/bookings/grid';
import { m } from '$lib/paraglide/messages';
import SpaceGrid from './SpaceGrid.svelte';
import WeekBar from './WeekBar.svelte';

const START = Date.parse('2026-11-02T08:00:00Z');
const STEP = 30 * 60_000;
const unit = (i: number, state: 'free' | 'blocked'): SlotUnit =>
  ({
    date: '2026-11-02',
    startMs: START + i * STEP,
    endMs: START + (i + 1) * STEP,
    state,
    ...(state === 'blocked' ? { blockReason: 'Accordage' } : {}),
  }) as SlotUnit;

const resource = { id: 'r1', name: 'Salle' } as BookerResource;
const space = {
  name: 'Espace',
  slotMode: 'step',
  maxSteps: 4,
  timeZone: 'UTC',
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
} as unknown as BookerSpace;

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function grid(blockMode: boolean) {
  const units = [unit(0, 'free'), unit(1, 'free'), unit(2, 'blocked')];
  const app = mount(SpaceGrid, {
    target: document.body,
    props: {
      space,
      resource,
      layout: weekLayout(units, ['2026-11-02'], space, START - 3600_000),
      mode: 'day',
      blockMode,
      nowMs: START - 3600_000,
      onPick: vi.fn(),
    },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
  return [...document.querySelectorAll<HTMLElement>('[data-cell]')];
}

describe('SpaceGrid in block mode', () => {
  it('draws free units with no "Libre" text and no green', async () => {
    const cells = await grid(true);
    const free = cells.filter((c) => !c.textContent!.includes('Accordage'));
    expect(free.length).toBeGreaterThan(0);
    for (const cell of free) {
      expect(cell.textContent!.trim()).toBe('');
      expect(cell.className).not.toContain('green-ok');
      // The word is still the cell's NAME for a screen reader.
      expect(cell.getAttribute('aria-label')).toContain(m.bookings_cell_free());
    }
    expect(cells.some((c) => c.textContent!.includes('Accordage'))).toBe(true);
  });

  it('keeps the booker green "Libre" outside block mode', async () => {
    const cells = await grid(false);
    const free = cells.find((c) => c.textContent!.includes(m.bookings_cell_free()));
    expect(free).toBeDefined();
    expect(free!.className).toContain('green-ok');
  });
});

describe('WeekBar key', () => {
  function key(blockMode: boolean) {
    const app = mount(WeekBar, {
      target: document.body,
      props: {
        label: '2 - 8 novembre',
        away: false,
        onPrevious: () => {},
        onNext: () => {},
        onToday: () => {},
        blockMode,
      },
    });
    mounted.push(() => unmount(app, { outro: false }));
    flushSync();
    return (id: string) => document.querySelector<HTMLElement>(`[data-swatch="${id}"]`)!.className;
  }

  it('matches the quiet cells in block mode', () => {
    const swatch = key(true);
    expect(swatch('free')).not.toContain('green-ok');
    expect(swatch('closed')).toContain('control-fill');
  });

  it('keeps the green free swatch for the booker', () => {
    expect(key(false)('free')).toContain('green-ok');
  });
});
