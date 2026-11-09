/**
 * BATCH 4 - booking a room: the Reservations page hint and the space page hint. Each on its route
 * only, every step kept on both layouts once its anchors are drawn, a step whose section is not
 * drawn left out, and the anchors really named in the sources (a renamed anchor fails here rather
 * than silently skipping the step in production).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { planGuide } from '../guideEngine.svelte';
import type { GuideDefinition, GuideLayout } from '../guideTypes';
import { isHelpId } from '../helpIds';
import { GUIDES } from './index';
import { bookingSpacesHint } from './bookingSpacesHint';
import { bookingWeekHint, isBookingSpacePage } from './bookingWeekHint';

vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));

const PHONE: GuideLayout = { phone: true, swipe: true, nativeTabBar: false };
const DESKTOP: GuideLayout = { phone: false, swipe: false, nativeTabBar: false };
const here = dirname(fileURLToPath(import.meta.url));
const src = (rel: string) => readFileSync(resolve(here, '../../..', rel), 'utf8');

const LIST_PAGE = 'routes/bookings/+page.svelte';
const WEEK = 'lib/components/bookings/booker/SpaceWeek.svelte';

const CASES: {
  guide: GuideDefinition;
  route: string;
  elsewhere: string;
  files: string[];
  anchors: string[];
}[] = [
  {
    guide: bookingSpacesHint,
    route: '/bookings',
    elsewhere: '/bookings/spaces/abc',
    files: [LIST_PAGE],
    anchors: ['bookings.mine', 'bookings.spaces'],
  },
  {
    guide: bookingWeekHint,
    route: '/bookings/spaces/abc',
    elsewhere: '/bookings',
    files: [WEEK],
    anchors: ['bookings.column', 'bookings.week'],
  },
];

describe.each(CASES)('$guide.id', ({ guide, route, elsewhere, files, anchors }) => {
  it('is a hint under a listed id, registered, applying to its route only', () => {
    expect(isHelpId(guide.id)).toBe(true);
    expect(guide.kind).toBe('hint');
    expect(GUIDES).toContain(guide);
    expect(guide.appliesTo(route)).toBe(true);
    expect(guide.appliesTo(elsewhere)).toBe(false);
  });

  it('keeps every step on both layouts once its anchors are drawn', () => {
    for (const layout of [PHONE, DESKTOP]) {
      const { steps, skipped } = planGuide(guide, layout, (a) => anchors.includes(a));
      expect(steps.map((s) => s.id)).toEqual(guide.steps.map((s) => s.id));
      expect(skipped).toEqual([]);
    }
  });

  it('leaves a step out, not-rendered, where its control is not drawn', () => {
    const { steps, skipped } = planGuide(guide, PHONE, () => false);
    expect(steps).toEqual([]);
    expect(skipped.every((s) => s.reason === 'not-rendered')).toBe(true);
  });

  it('names anchors the sources really mark', () => {
    const source = files.map(src).join('\n');
    for (const anchor of anchors) expect(source.includes(`'${anchor}'`), anchor).toBe(true);
  });
});

describe('the anchors follow what the page draws', () => {
  it('a space with one column shows the week step only', () => {
    const { steps } = planGuide(bookingWeekHint, PHONE, (a) => a === 'bookings.week');
    expect(steps.map((s) => s.id)).toEqual(['week']);
  });

  it('an empty or failed spaces list shows the reservations step only', () => {
    const { steps } = planGuide(bookingSpacesHint, PHONE, (a) => a === 'bookings.mine');
    expect(steps.map((s) => s.id)).toEqual(['mine']);
  });

  it('the spaces anchor sits in the branch that draws the list, the column one in the selector branch', () => {
    const page = src(LIST_PAGE);
    const list = page.indexOf('<SpaceList');
    expect(page.lastIndexOf("use:guideAnchor={'bookings.spaces'}", list)).toBeGreaterThan(
      page.lastIndexOf('{:else if spaces.length === 0}')
    );
    const week = src(WEEK);
    expect(week.indexOf("'bookings.column'")).toBeGreaterThan(
      week.indexOf('{#if space.resources.length > 1 && resource}')
    );
  });

  it('the week anchors are marked only once the first read landed, in book mode', () => {
    const week = src(WEEK);
    expect(week).toContain("mode === 'book' && loaded ? 'bookings.week' : undefined");
    expect(week).toContain("mode === 'book' && loaded ? 'bookings.column' : undefined");
  });

  it('the week step words differ by layout (planning list on a phone, grid on a wide screen)', () => {
    const body = bookingWeekHint.steps[1].body as { byLayout: (l: GuideLayout) => () => string };
    expect(body.byLayout(PHONE)).not.toBe(body.byLayout(DESKTOP));
    // The phone's "Réserver un créneau" is only the aria-label of an icon-only "+": name the button.
    const fr = JSON.parse(src('../messages/fr.json')) as Record<string, string>;
    const en = JSON.parse(src('../messages/en.json')) as Record<string, string>;
    expect(fr.guide_hint_booking_week_body_phone).toContain('le bouton +');
    expect(en.guide_hint_booking_week_body_phone).toContain('the + button');
    expect(fr.guide_hint_booking_week_body_phone).not.toContain('Réserver un créneau');
    expect(en.guide_hint_booking_week_body_phone).not.toContain('Book a slot');
  });

  it('the Reservations hint is replayable from its fixed route, the space one is not', () => {
    expect(bookingSpacesHint.replay?.route).toBe('/bookings');
    expect(bookingWeekHint.replay).toBeUndefined();
  });
});

describe('the space route', () => {
  it('matches the booker page and not the organiser pages', () => {
    expect(isBookingSpacePage('/bookings/spaces/abc')).toBe(true);
    expect(isBookingSpacePage('/bookings/spaces/abc/')).toBe(true);
    expect(isBookingSpacePage('/bookings/spaces/abc/manage')).toBe(false);
    expect(isBookingSpacePage('/bookings/spaces/abc/edit')).toBe(false);
    expect(isBookingSpacePage('/bookings')).toBe(false);
  });
});
