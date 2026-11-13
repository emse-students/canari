// @vitest-environment happy-dom
/**
 * THE RESERVATIONS PAGE ASKS ITS THREE READS TOGETHER (weak-network audit, C1). The personal
 * spaces used to be read by the tab, mounted only once `myBookings` and `listSpaces` had both
 * answered: a third serial round trip for a read that needs nothing from them. Counted on a fake
 * network, no clock: all three are on the wire before any is answered, and the tab draws the rows
 * the page asked for without asking again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';

const myBookings = vi.fn();
const listSpaces = vi.fn();
const listManagedSpaces = vi.fn();

vi.mock('$lib/bookings/api', () => ({
  myBookings: (...a: unknown[]) => myBookings(...a),
  listSpaces: (...a: unknown[]) => listSpaces(...a),
  listManagedSpaces: (...a: unknown[]) => listManagedSpaces(...a),
  createSpace: vi.fn(),
}));
vi.mock('$lib/bookings/redrawClock', () => ({ redrawEveryMinuteAndAt: () => () => {} }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/guidance/guideAnchors.svelte', () => ({ guideAnchor: () => ({}) }));

import Page from './+page.svelte';

const mounted: ReturnType<typeof mount>[] = [];
afterEach(() => {
  for (const c of mounted.splice(0)) unmount(c);
  vi.clearAllMocks();
});

describe('the reservations page reads', () => {
  it('has the three reads on the wire before any answers, and the tab never asks again', async () => {
    let answerBookings!: (v: unknown[]) => void;
    let answerSpaces!: (v: unknown[]) => void;
    let answerManaged!: (v: unknown[]) => void;
    myBookings.mockReturnValue(new Promise((r) => (answerBookings = r)));
    listSpaces.mockReturnValue(new Promise((r) => (answerSpaces = r)));
    listManagedSpaces.mockReturnValue(new Promise((r) => (answerManaged = r)));

    mounted.push(mount(Page, { target: document.body }));
    flushSync();
    await tick();

    // Level 1 only: nothing has answered, and all three reads are already out.
    expect(myBookings).toHaveBeenCalledTimes(1);
    expect(listSpaces).toHaveBeenCalledTimes(1);
    expect(listManagedSpaces).toHaveBeenCalledTimes(1);
    expect(listManagedSpaces).toHaveBeenCalledWith(null);

    answerManaged([]);
    answerBookings([]);
    answerSpaces([]);
    for (let i = 0; i < 5; i++) await tick();

    expect(listManagedSpaces).toHaveBeenCalledTimes(1);
  });
});
