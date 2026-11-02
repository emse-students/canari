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
import { weekLayout } from '$lib/bookings/grid';
import SpaceGrid from './SpaceGrid.svelte';

const START = Date.parse('2026-11-02T08:00:00Z');
const STEP = 30 * 60_000;
// Before the first unit: every unit drawn is still to come, so the booker's grid offers it.
const NOW = START - STEP;

function unit(index: number, state: 'free' | 'blocked' = 'free'): SlotUnit {
  return {
    date: '2026-11-02',
    startMs: START + index * STEP,
    endMs: START + (index + 1) * STEP,
    state,
  } as SlotUnit;
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

/** Mounts one day of `units` and returns its cells in time order. */
async function open(units: SlotUnit[], space = spaceOf(4), blockMode = false, now = NOW) {
  const app = mount(SpaceGrid, {
    target: document.body,
    props: {
      space,
      resource,
      layout: weekLayout(units, ['2026-11-02'], space, now),
      blockMode,
      nowMs: now,
      onPick,
    },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
  return cellsByIndex();
}

/**
 * The hit areas by the index of their unit in the day. Only FREE units have one
 * (a booking or a block is one button of its own; a refused start keeps a DISABLED one, so a drag
 * can still cross it), so the others are `undefined` and each unit keeps its own index.
 */
function cellsByIndex(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const cell of document.querySelectorAll<HTMLElement>('[data-cell]')) {
    out[Number(cell.dataset.idx)] = cell;
  }
  return out;
}

/** A pointer event on `target`; `y` is the UNIT (its index in the day) the stubbed hit-test will answer with. */
function pointer(type: string, target: Element, kind: 'mouse' | 'touch', x = 0, y = 0) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: kind } });
  target.dispatchEvent(event);
  flushSync();
}

beforeEach(() => {
  onPick.mockReset();
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  // jsdom has no layout and no pointer capture: the hit-test answers by the unit index in `clientY`.
  Element.prototype.setPointerCapture = vi.fn();
  document.elementFromPoint = (_x: number, y: number) =>
    document.querySelector(`[data-cell][data-day="0"][data-idx="${y}"]`);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const free = (n: number) => Array.from({ length: n }, (_, i) => unit(i));

describe('SpaceGrid - drag a range', () => {
  it('draws a closed day of the week as a folded strip with no unit to press', async () => {
    const app = mount(SpaceGrid, {
      target: document.body,
      props: {
        space: spaceOf(4),
        resource,
        layout: weekLayout(free(2), ['2026-11-02', '2026-11-03'], spaceOf(4), START),
        nowMs: NOW,
        onPick,
      },
    });
    mounted.push(() => unmount(app, { outro: false }));
    flushSync();
    await tick();
    const groups = [...document.querySelectorAll('[role="group"][aria-label]')];
    expect(document.querySelectorAll('[data-cell]')).toHaveLength(2);
    expect(groups.some((g) => g.getAttribute('aria-label')?.includes('mardi'))).toBe(true);
    expect(document.querySelector('[data-day="1"]')).toBeNull();
  });

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
    // ONE accent block for the whole range, not a coloured cell per unit.
    expect(document.querySelectorAll('[data-selection]')).toHaveLength(1);
    expect(document.querySelector('[data-selection]')!.className).toContain('bg-cn-yellow');
    pointer('pointerup', cells[2], 'mouse', 20, 2);
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('drags DOWN past units the horizon refuses as starts: only the start is judged', async () => {
    // A one-day horizon ending inside unit 2: units 2.. are refused AS STARTS, not as steps.
    const space = { ...spaceOf(4), horizonDays: 1 } as BookerSpace;
    const now = START - 24 * 3_600_000 + 1.5 * STEP;
    const units = free(6);
    const cells = await open(units, space, false, now);
    expect((cells[2] as HTMLButtonElement).disabled).toBe(true);
    pointer('pointerdown', cells[1], 'mouse', 0, 1);
    pointer('pointermove', cells[1], 'mouse', 20, 3);
    pointer('pointerup', cells[1], 'mouse', 20, 3);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[1], 3);
  });

  it('stops an UPWARD drag before a unit the window refuses as a start', async () => {
    // A 1 h notice from NOW (30 min before unit 0): unit 0 is too near to start a booking.
    const space = { ...spaceOf(4), minNoticeMinutes: 60 } as BookerSpace;
    const units = free(6);
    const cells = await open(units, space);
    pointer('pointerdown', cells[3], 'mouse', 0, 3);
    pointer('pointermove', cells[3], 'mouse', 20, 0);
    pointer('pointerup', cells[3], 'mouse', 20, 0);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[1], 3);
  });

  it('never offers the latest start the server refused, nor any start before it', async () => {
    const units = free(3);
    const app = mount(SpaceGrid, {
      target: document.body,
      props: {
        space: spaceOf(4),
        resource,
        layout: weekLayout(units, ['2026-11-02'], spaceOf(4), NOW),
        nowMs: NOW,
        lastRefusedStart: units[1].startMs,
        onPick,
      },
    });
    mounted.push(() => unmount(app, { outro: false }));
    flushSync();
    await tick();
    const cells = cellsByIndex();
    // Both refusals only grow with time: the refused start and every earlier one are retired.
    expect((cells[0] as HTMLButtonElement).disabled).toBe(true);
    expect((cells[1] as HTMLButtonElement).disabled).toBe(true);
    expect((cells[2] as HTMLButtonElement).disabled).toBe(false);
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

describe('SpaceGrid - block mode, the organiser dashboard (WP-R5, D50)', () => {
  it('drags past what one booking may cover, up to a block, in red', async () => {
    const units = free(8);
    const cells = await open(units, spaceOf(2), true);
    pointer('pointerdown', cells[1], 'mouse', 0, 1);
    pointer('pointermove', cells[1], 'mouse', 0, 1);
    pointer('pointermove', cells[6], 'mouse', 20, 6);
    expect(document.querySelector('[data-selection]')!.className).toContain('border-red-err');
    pointer('pointerup', cells[6], 'mouse', 20, 6);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[1], 6);
  });

  it('drags in a space of whole slots too', async () => {
    const units = free(4);
    const cells = await open(units, spaceOf(4, 'slots'), true);
    pointer('pointerdown', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[2], 'mouse', 20, 2);
    pointer('pointerup', cells[2], 'mouse', 20, 2);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[0], 3);
  });

  it('stops at a unit that is not free, so a block drag never crosses a booking', async () => {
    const units = [unit(0), unit(1), unit(2, 'blocked'), unit(3)];
    const cells = await open(units, spaceOf(4), true);
    pointer('pointerdown', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[0], 'mouse', 0, 0);
    pointer('pointermove', cells[3], 'mouse', 20, 3);
    pointer('pointerup', cells[3], 'mouse', 20, 3);
    expect(onPick).toHaveBeenCalledExactlyOnceWith(resource, units[0], 2);
  });
});
