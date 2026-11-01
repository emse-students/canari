// @vitest-environment happy-dom
/**
 * A NARROW, TALL BOOKED BLOCK STILL SAYS WHO AND WHEN (owner, 2026-11-01): the text used to be
 * hidden by a width rule whatever the block's height, so a week column showed the avatar alone.
 * Width now only chooses the layout (a row, or a stack under the avatar); height alone decides
 * whether the text exists. happy-dom has no container queries, so what is asserted here is that
 * the name and the hours are in the block and that nothing hides them by width; the rendering at
 * real widths is read in the browser.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerResource, BookerSpace, SlotUnit } from '$lib/bookings/api';
import { weekLayout } from '$lib/bookings/grid';
import { stackedLines } from '$lib/bookings/gridRuns';
import SpaceGrid from './SpaceGrid.svelte';

const START = Date.parse('2026-11-02T08:00:00Z');
const STEP = 30 * 60_000;
const resource = { id: 'r1', name: 'Salle' } as BookerResource;
const space = {
  name: 'Espace',
  slotMode: 'step',
  maxSteps: 8,
  timeZone: 'UTC',
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
} as unknown as BookerSpace;

const booked = (i: number): SlotUnit =>
  ({
    date: '2026-11-02',
    startMs: START + i * STEP,
    endMs: START + (i + 1) * STEP,
    state: 'booked',
    booking: { id: 'b1', holderName: 'Camille Test', holderId: undefined, mine: false },
  }) as unknown as SlotUnit;

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

async function draw(units: SlotUnit[]) {
  const app = mount(SpaceGrid, {
    target: document.body,
    props: {
      space,
      resource,
      layout: weekLayout(units, ['2026-11-02'], space, START - 3600_000),
      mode: 'week',
      nowMs: START - 3600_000,
      onPick: vi.fn(),
    },
  });
  mounted.push(() => unmount(app, { outro: false }));
  flushSync();
  await tick();
  return document.querySelector<HTMLElement>('button[title*="Camille Test"]')!;
}

describe('a booked block in a narrow column', () => {
  it('renders the holder name and the time range, and nothing hides them by width', async () => {
    // 3 hours: tall enough for the name and the hours on two lines.
    const block = await draw([0, 1, 2, 3, 4, 5].map(booked));
    expect(block.textContent).toContain('Camille Test');
    expect(block.textContent).toContain('08:00 - 11:00');
    // The name has no width-driven `hidden` anywhere above it.
    const name = [...block.querySelectorAll('span')].find((s) => s.textContent === 'Camille Test')!;
    for (let el: Element | null = name; el && el !== block; el = el.parentElement) {
      expect(el.className).not.toMatch(/@max-\[6rem\]:hidden/);
      expect(el.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    }
    // The hours can go on two lines, start then end, for the narrowest columns.
    const split = block.querySelector('[data-time-split]')!;
    expect([...split.querySelectorAll('span')].map((s) => s.textContent)).toEqual([
      '08:00',
      '11:00',
    ]);
  });
});

describe('stackedLines', () => {
  it('says how much a narrow block can stack under its avatar, by height', () => {
    expect([2.5, 3, 4.5, 6].map(stackedLines)).toEqual([0, 1, 2, 3]);
  });
});
