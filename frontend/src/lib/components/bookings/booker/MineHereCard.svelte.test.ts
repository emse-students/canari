// @vitest-environment happy-dom
/** "VOS RESERVATIONS ICI": the empty sentence, and a row per booking with its range and who is with them. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { setLocale } from '$lib/paraglide/runtime';
import { m } from '$lib/paraglide/messages';
import type { MyBooking } from '$lib/bookings/api';
import MineHereCard from './MineHereCard.svelte';

const mounted: ReturnType<typeof mount>[] = [];

function row(id: string, over: Partial<MyBooking> = {}): MyBooking {
  return {
    id,
    startsAt: '2026-11-02T16:00:00Z',
    endsAt: '2026-11-02T17:00:00Z',
    space: { id: 's1', name: 'Salle', timeZone: 'Europe/Paris' },
    resource: { id: 'r1', name: 'Salle' },
    ...over,
  } as MyBooking;
}

function render(bookings: MyBooking[]) {
  mounted.push(mount(MineHereCard, { target: document.body, props: { bookings } }));
  flushSync();
}

beforeEach(() => setLocale('en', { reload: false }));
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!, { outro: false });
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('MineHereCard', () => {
  it('says there is nothing, under its heading, when the list is empty', () => {
    render([]);
    expect(document.querySelector('h2')?.textContent?.trim()).toBe(m.bookings_mine_here_heading());
    expect(document.body.textContent).toContain(m.bookings_mine_here_empty());
    expect(document.querySelectorAll('li').length).toBe(0);
  });

  it('draws one row per booking, on the space clock, with the people or the column', () => {
    render([
      row('a', { participantNames: ['Lea M.'] }),
      row('b', { resource: { id: 'r2', name: 'Table 2' } as MyBooking['resource'] }),
    ]);
    const rows = [...document.querySelectorAll('li')];
    expect(rows.length).toBe(2);
    // 16:00Z is 17:00 in Paris in November.
    expect(rows[0].textContent).toContain('17:00');
    expect(rows[0].textContent).toContain('Lea M.');
    expect(rows[1].textContent).toContain('Table 2');
    expect(document.body.textContent).not.toContain(m.bookings_mine_here_empty());
  });

  it('does not repeat a column named like its space', () => {
    render([row('a')]);
    expect(document.querySelectorAll('li p').length).toBe(1);
  });
});
