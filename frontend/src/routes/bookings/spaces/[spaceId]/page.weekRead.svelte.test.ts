// @vitest-environment happy-dom
/**
 * A SLOW READ FOR A WEEK LEFT BEHIND MUST NOT LAND ON THE WEEK SHOWN: week 1 is loaded, "next"
 * launches a slow read for week 2, "previous" comes back to week 1 (a cache hit, no read) - and
 * when the slow read answers the grid must still hold week 1. The guard used to be bumped only
 * when a read launched, so the cache hit left the stale answer looking current.
 */
import { it, expect, afterEach, beforeEach, vi } from 'vitest';
import { flushSync, mount, tick, unmount } from 'svelte';
import type { BookerSpace, ResourceSlots } from '$lib/bookings/api';
import { m } from '$lib/paraglide/messages';

const api = vi.hoisted(() => ({
  getSpace: vi.fn(),
  getSlots: vi.fn(),
  myBookings: vi.fn(async () => []),
}));

vi.mock('$lib/bookings/api', () => api);
vi.mock('$app/state', () => ({
  page: { params: { spaceId: 's1' }, url: new URL('https://x.test/') },
}));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/seo/pageTitle.svelte', () => ({ setPageTitle: vi.fn() }));

import Page from './+page.svelte';

const SPACE = {
  id: 's1',
  name: 'Espace',
  timeZone: 'Europe/Paris',
  slotMode: 'step',
  stepMinutes: 30,
  maxSteps: 4,
  opensAt: null,
  minNoticeMinutes: null,
  horizonDays: null,
  canManage: false,
  poster: null,
  items: [],
  hiddenItemIds: [],
  resources: [{ id: 'r1', name: 'Salle' }],
} as unknown as BookerSpace;

const WEEK_ONE: ResourceSlots[] = [
  {
    resourceId: 'r1',
    units: [
      {
        date: '2026-11-04',
        startMs: Date.parse('2026-11-04T08:00:00Z'),
        endMs: Date.parse('2026-11-04T08:30:00Z'),
        state: 'free',
      },
    ],
  },
] as unknown as ResourceSlots[];

const mounted: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-04T10:00:00Z'));
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  api.getSpace.mockResolvedValue(SPACE);
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it('keeps the week shown when a slow read for another week answers after the way back', async () => {
  let answerSlow: (rows: ResourceSlots[]) => void = () => {};
  api.getSlots
    .mockResolvedValueOnce(WEEK_ONE)
    .mockReturnValueOnce(new Promise<ResourceSlots[]>((resolve) => (answerSlow = resolve)));
  const app = mount(Page, { target: document.body });
  mounted.push(() => unmount(app, { outro: false }));
  await vi.waitFor(() => expect(document.querySelectorAll('[data-cell]').length).toBe(1));

  const press = (label: string) =>
    document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click();
  press(m.bookings_week_next());
  flushSync();
  expect(api.getSlots).toHaveBeenCalledTimes(2);
  press(m.bookings_week_previous());
  flushSync();
  expect(api.getSlots).toHaveBeenCalledTimes(2);

  answerSlow([{ resourceId: 'r1', units: [] }]);
  await tick();
  await tick();
  expect(document.querySelectorAll('[data-cell]').length).toBe(1);
});
