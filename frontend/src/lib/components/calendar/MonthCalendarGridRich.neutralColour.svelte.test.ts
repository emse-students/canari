// @vitest-environment happy-dom
/**
 * THE MONTH GRID PAINTS A NEUTRAL EVENT IN THE BDE'S CHOSEN COLOUR (owner, 2026-11-14), the fixed
 * `campus`-derived yellow only when the BDE chose nothing.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import { associationAccentHex } from '$lib/associations/accent';
import { NEUTRAL_EVENT_OWNER_KEY } from '$lib/calendar/feedEvents';
import { setLocale } from '$lib/paraglide/runtime';
import MonthCalendarGridRich from './MonthCalendarGridRich.svelte';

const mounted: ReturnType<typeof mount>[] = [];
beforeEach(() => setLocale('en', { reload: false }));
afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

function render(neutralEventColor: string | null): string {
  const event = {
    id: 'ev-1',
    associationId: '',
    title: 'Gala',
    description: null,
    startsAt: '2026-11-13T12:00:00.000Z',
    endsAt: null,
    kind: 'event',
    presentation: 'neutral',
    status: 'validated',
    coOwners: [],
    associationName: '',
    associationSlug: '',
    associationColor: null,
    associationLogoUrl: null,
    neutralEventColor,
  } as unknown as AssociationCalendarFeedEvent;
  mounted.push(
    mount(MonthCalendarGridRich, {
      target: document.body,
      props: { focusDate: new Date(2026, 10, 15), events: [event] },
    })
  );
  flushSync();
  return document.body.innerHTML.toLowerCase();
}

describe('MonthCalendarGridRich - neutral event colour', () => {
  it('uses the BDE colour', () => {
    expect(render('#336699')).toContain('#336699');
  });

  it('draws no logo or initials watermark with a chosen colour either (#3823)', () => {
    render('#336699');
    expect(document.body.querySelectorAll('img')).toHaveLength(0);
    const initials = [...document.body.querySelectorAll('span')]
      .map((s) => s.textContent?.trim() ?? '')
      .filter((t) => /^[A-Z]{1,2}$/.test(t));
    expect(initials).toEqual([]);
  });

  it('keeps the derived accent when none is chosen', () => {
    const derived = associationAccentHex({
      id: NEUTRAL_EVENT_OWNER_KEY,
      color: null,
    }).toLowerCase();
    const html = render(null);
    expect(html).toContain(derived);
    expect(html).not.toContain('#336699');
  });
});
