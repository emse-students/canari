// @vitest-environment happy-dom
/**
 * DRAGGING OVER THE GRID PICKS A RANGE (user, 2026-10-21): press a free unit and drag along the
 * resource's column. Pinned: a mouse drags at once, a finger must hold first (a quick drag is a
 * scroll and is left alone), the range is clamped to free touching units and to what one booking
 * may cover, a plain tap is still a pick of one unit, and a drag is never also a click.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import type { GridRow } from '$lib/bookings/grid';
import SpaceGrid from './SpaceGrid.svelte';

const START = Date.parse('2026-11-02T08:00:00Z');
const STEP = 30 * 60_000;

function unit(index: number, state: 'free' | 'blocked' = 'free'): SlotUnit {
  return {
    date: '2026-11-02',
    startMs: START + index * STEP,
    endMs: START + (index + 1) * STEP,
    state,
  } as SlotUnit;
}

function rowsOf(units: SlotUnit[]): GridRow[] {
  return units.map((u, i) => ({
    key: String(i),
    startMs: u.startMs,
    endMs: u.endMs,
    label: `row ${i}`,
    nextDay: false,
    cells: [u],
  }));
}

const resource = { id: 'r1', name: 'Salle' } as BookerResource;
const spaceOf = (maxSteps: number, slotMode: 'step' | 'slots' = 'step') =>
  ({
    name: 'Espace',
    slotMode,
    maxSteps,
    timeZone: 'Europe/Paris',
    opensAt: null,
    minNoticeMinutes: null,
    horizonDays: null,
  }) as unknown as BookerSpace;

const mounted: (() => void)[] = [];
const onPick = vi.fn();

/** Mounts a grid of `units` and returns its cells by row. */
async function open(units: SlotUnit[], space = spaceOf(4)) {
  const app = mount(SpaceGrid, {
    target: document.body,
    props: { space, resources: [resource], rows: rowsOf(units), nowMs: START, onPick },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
  return [...document.querySelectorAll<HTMLElement>('[data-cell]')];
}

/** A pointer event on `target`; `y` is the ROW the stubbed hit-test will answer with. */
function pointer(type: string, target: Element, kind: 'mouse' | 'touch', x = 0, y = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: kind } });
  target.dispatchEvent(event);
  flushSync();
}

beforeEach(() => {
  onPick.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // jsdom has no layout and no pointer capture: the hit-test answers by the row number in `clientY`.
  Element.prototype.setPointerCapture = vi.fn();
  document.elementFromPoint = (_x: number, y: number) =>
    document.querySelector(`[data-cell][data-row="${y}"]`);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const free = (n: number) => Array.from({ length: n }, (_, i) => unit(i));

describe('SpaceGrid - drag a range', () => {
  it('a mouse press and drag down picks the units it crossed, once, and is not also a click', async () => {
    const units = free(6);
    const cells = await open(units);
    pointer('pointerdown', cells[1], 'mouse', 0, 1);
    pointer('pointermove', cells[1], 'mouse', 0, 1);
    pointer('pointermove', cells[3], 'mouse', 20, 3);
    pointer('pointerup', cells[3], 'mouse', 20, 3);
    cells[3].click();
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[1], 3);
  });

  it('draws the range while dragging and says its hours', async () => {
    const cells = await open(free(6));
    pointer('pointerdown', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[2], 'mouse', 20, 2);
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/\d/);
    expect(cells[0].className).toContain('bg-cn-yellow');
    expect(cells[2].className).toContain('bg-cn-yellow');
    expect(cells[3].className).not.toContain('bg-cn-yellow/40');
    pointer('pointerup', cells[2], 'mouse', 20, 2);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('drags upward from the lower row, the first unit being the upper one', async () => {
    const units = free(6);
    const cells = await open(units);
    pointer('pointerdown', cells[4], 'mouse', 0, 4);
    pointer('pointermove', cells[2], 'mouse', 20, 2);
    pointer('pointerup', cells[2], 'mouse', 20, 2);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[2], 3);
  });

  it('never picks more than one booking may cover', async () => {
    const units = free(6);
    const cells = await open(units, spaceOf(2));
    pointer('pointerdown', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[5], 'mouse', 20, 5);
    pointer('pointerup', cells[5], 'mouse', 20, 5);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[0], 2);
  });

  it('stops before a unit that is taken', async () => {
    const units = [unit(0), unit(1), unit(2, 'blocked'), unit(3)];
    const cells = await open(units);
    pointer('pointerdown', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[3], 'mouse', 20, 3);
    pointer('pointerup', cells[3], 'mouse', 20, 3);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[0], 2);
  });

  it('a plain click is still a pick of one unit', async () => {
    const units = free(3);
    const cells = await open(units);
    pointer('pointerdown', cells[1], 'mouse', 0, 1);
    pointer('pointerup', cells[1], 'mouse', 0, 1);
    cells[1].click();
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[1]);
  });

  it('a finger that moves before the hold is a scroll: nothing is drawn or picked', async () => {
    vi.useFakeTimers();
    const cells = await open(free(6));
    pointer('pointerdown', cells[0], 'touch', 0, 0);
    pointer('pointermove', cells[1], 'touch', 0, 40);
    vi.advanceTimersByTime(400);
    flushSync();
    pointer('pointermove', cells[3], 'touch', 0, 3);
    pointer('pointerup', cells[3], 'touch', 0, 3);
    expect(document.querySelector('[role="status"]')).toBeNull();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('a finger that holds, then drags, draws the range', async () => {
    vi.useFakeTimers();
    const units = free(6);
    const cells = await open(units);
    pointer('pointerdown', cells[1], 'touch', 0, 1);
    vi.advanceTimersByTime(300);
    flushSync();
    pointer('pointermove', cells[3], 'touch', 0, 3);
    pointer('pointerup', cells[3], 'touch', 0, 3);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[1], 3);
  });

  it('offers no drag for a space of whole slots', async () => {
    const units = free(3);
    const cells = await open(units, spaceOf(4, 'slots'));
    expect(document.body.textContent).not.toContain('Glissez');
    pointer('pointerdown', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[2], 'mouse', 20, 2);
    pointer('pointerup', cells[2], 'mouse', 20, 2);
    expect(onPick).not.toHaveBeenCalled();
  });
});
