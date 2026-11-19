// @vitest-environment happy-dom
/**
 * A NEUTRAL "CAMPUS" EVENT IN THE MONTH GRID DRAWS NO WATERMARK - NEVER THE INITIALS "CA".
 *
 * #3455 gave the day panel, the list, the modal chip and the export the generic treatment, but the
 * month grid's cell kept its logo watermark, whose no-logo fallback is the owner's initials: a
 * neutral event still wore a translucent "CA" (owner, 2026-11-18). A neutral event's colour is its
 * whole drawing, as on the export; an association without a logo keeps its initials.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import { setLocale } from '$lib/paraglide/runtime';
import MonthCalendarGridRich from './MonthCalendarGridRich.svelte';

const mounted: ReturnType<typeof mount>[] = [];

beforeEach(() => {
  setLocale('en', { reload: false });
});

afterEach(() => {
  while (mounted.length) unmount(mounted.pop()!);
  document.body.innerHTML = '';
});

/** One event on 2026-12-01, as a READER receives it; `neutral` blanks the owner like the server. */
function eventOn(neutral: boolean): AssociationCalendarFeedEvent {
  return {
    id: neutral ? 'ev-neutral' : 'ev-assoc',
    title: neutral ? 'Don du sang' : 'Gala',
    description: null,
    startsAt: '2026-12-01T10:00:00.000Z',
    endsAt: null,
    kind: 'event',
    presentation: neutral ? 'neutral' : 'association',
    status: 'approved',
    coOwners: [],
    associationId: neutral ? '' : 'assoc-1',
    associationName: neutral ? '' : 'Cercle Astro',
    associationSlug: neutral ? '' : 'cercle-astro',
    associationColor: null,
    associationLogoUrl: null,
  } as unknown as AssociationCalendarFeedEvent;
}

function render(events: AssociationCalendarFeedEvent[]): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(
    mount(MonthCalendarGridRich, {
      target,
      props: { focusDate: new Date('2026-12-15T12:00:00.000Z'), events },
    })
  );
  flushSync();
  return target;
}

/** The watermark's initials discs: the fallback spans the grid draws inside a logo circle. */
function initialsShown(root: HTMLElement): string[] {
  return [...root.querySelectorAll('span')]
    .map((s) => s.textContent?.trim() ?? '')
    .filter((t) => /^[A-Z]{1,2}$/.test(t));
}

describe('MonthCalendarGridRich - a neutral event', () => {
  it('draws its title and no initials watermark', () => {
    const root = render([eventOn(true)]);
    expect(root.textContent).toContain('Don du sang');
    expect(initialsShown(root)).toEqual([]);
  });

  it('still draws the initials of an association that has no logo', () => {
    const root = render([eventOn(false)]);
    expect(initialsShown(root)).toEqual(['CA']);
  });
});
