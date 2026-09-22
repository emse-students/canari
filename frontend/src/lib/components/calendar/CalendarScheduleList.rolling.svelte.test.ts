/**
 * THE PHONE AGENDA ROLLS FORWARD FROM TODAY, AND THREE THINGS MAKE THAT TRUE ON SCREEN.
 *
 * The visible change of 2026-09-20 is not one behaviour but three, and each fails silently on its
 * own: the window's first day is honoured (or the list still opens on days that have happened), the
 * flow is cut into named months (or 3 December and 3 January are the same row), and the scroll keeps
 * asking (or it stops dead somewhere down the year with no sign that it has).
 *
 * THE RE-ARM IS THE ONE THAT CANNOT BE SEEN BY READING. An `IntersectionObserver` reports
 * TRANSITIONS, so appending a chunk below a sentinel that never left the screen fires nothing, and
 * a quiet stretch - three months that add no rows at all - ends the scroll for good. That is a
 * working list everywhere the data happens to be dense, which is exactly where it would be tested
 * by hand.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import type { AgendaRollingWindow } from '$lib/calendar/agendaMonth.svelte';
import { setLocale } from '$lib/paraglide/runtime';
import CalendarScheduleList from './CalendarScheduleList.svelte';

/** One stubbed observer, kept so a test can say what the reader's scroll just did. */
interface StubObserver {
  callback: IntersectionObserverCallback;
  targets: Element[];
  disconnected: boolean;
}

let observers: StubObserver[] = [];
const mounted: (() => void)[] = [];

beforeEach(() => {
  observers = [];
  // happy-dom has no IntersectionObserver, and a real one would need a real viewport anyway. What
  // the component owes is the WIRING - which element it watches and when it watches it again - so
  // the crossings themselves are delivered by hand below.
  class StubIntersectionObserver implements StubObserver {
    targets: Element[] = [];
    disconnected = false;
    constructor(public callback: IntersectionObserverCallback) {
      observers.push(this);
    }
    observe(el: Element) {
      this.targets.push(el);
    }
    unobserve() {}
    disconnect() {
      this.disconnected = true;
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', StubIntersectionObserver);
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** Local-time ISO, so the test says the same thing wherever it runs. */
function localIso(y: number, m: number, d: number, h = 12): string {
  return new Date(y, m - 1, d, h).toISOString();
}

function event(partial: Partial<AssociationCalendarFeedEvent>): AssociationCalendarFeedEvent {
  return {
    id: 'e1',
    title: 'Event',
    startsAt: localIso(2026, 9, 28),
    endsAt: null,
    associationId: 'a1',
    associationName: 'BDE',
    associationSlug: 'bde',
    associationColor: null,
    associationLogoUrl: null,
    ...partial,
  } as AssociationCalendarFeedEvent;
}

/** A window the test drives by hand, with the two flags the component actually reacts to. */
function stubWindow(from: Date, to: Date) {
  let loadingMore = $state(false);
  let complete = $state(false);
  const loadMore = vi.fn();
  const setVisibleMonth = vi.fn();
  const window: AgendaRollingWindow = {
    get from() {
      return from;
    },
    get to() {
      return to;
    },
    get complete() {
      return complete;
    },
    get loadingMore() {
      return loadingMore;
    },
    get stalled() {
      return false;
    },
    loadMore,
    retry: vi.fn(),
    setVisibleMonth,
  };
  return {
    window,
    loadMore,
    setVisibleMonth,
    finishAStep() {
      loadingMore = true;
      flushSync();
      loadingMore = false;
      flushSync();
    },
    reachHorizon() {
      complete = true;
      flushSync();
    },
  };
}

function render(events: AssociationCalendarFeedEvent[], rolling: AgendaRollingWindow) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(CalendarScheduleList, {
    target,
    props: { events, rolling, onEventClick: vi.fn() },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

/** The footer element the scroll watches - absent once the horizon is reached. */
function sentinelOf(root: HTMLElement): HTMLElement | null {
  return root.querySelector('[aria-live="polite"]');
}

/** The observer currently watching `el`, ignoring the ones already thrown away. */
function watcherOf(el: Element): StubObserver | undefined {
  return observers.find((o) => !o.disconnected && o.targets.includes(el));
}

function cross(observer: StubObserver, target: Element): void {
  observer.callback(
    [{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
    observer as unknown as IntersectionObserver
  );
  flushSync();
}

describe('CalendarScheduleList - the rolling window on screen', () => {
  it('draws nothing before the day the window opens on', () => {
    // The 28th is the case the whole shape exists for: a month-aligned list would have opened on
    // the 3rd and made the reader scroll past 25 days that are over.
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 8, 30));
    const root = render(
      [
        event({ id: 'past', title: 'Passe', startsAt: localIso(2026, 9, 3) }),
        event({ id: 'soon', title: 'A venir', startsAt: localIso(2026, 9, 29) }),
      ],
      rolling.window
    );

    expect(root.textContent).toContain('A venir');
    expect(root.textContent).not.toContain('Passe');
  });

  it('cuts the flow into named months, in order', () => {
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 10, 30));
    const root = render(
      [
        event({ id: 'sep', startsAt: localIso(2026, 9, 29) }),
        event({ id: 'oct', startsAt: localIso(2026, 10, 2) }),
        event({ id: 'nov', startsAt: localIso(2026, 11, 4) }),
      ],
      rolling.window
    );

    // Without these headings a flow that crosses months says "3" twice and means two dates.
    const headings = [...root.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['septembre 2026', 'octobre 2026', 'novembre 2026']);
  });

  it('gives a month with no events no heading of its own', () => {
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 10, 30));
    const root = render(
      [
        event({ id: 'sep', startsAt: localIso(2026, 9, 29) }),
        event({ id: 'nov', startsAt: localIso(2026, 11, 4) }),
      ],
      rolling.window
    );

    const headings = [...root.querySelectorAll('h3')].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['septembre 2026', 'novembre 2026']);
  });

  it('asks for the next chunk when the foot of the list comes into view', () => {
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 10, 30));
    const root = render([event({ id: 'sep', startsAt: localIso(2026, 9, 29) })], rolling.window);

    const sentinel = sentinelOf(root)!;
    cross(watcherOf(sentinel)!, sentinel);

    expect(rolling.loadMore).toHaveBeenCalledTimes(1);
  });

  it('asks AGAIN after a step that added nothing, because an observer only reports crossings', () => {
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 10, 30));
    const root = render([event({ id: 'sep', startsAt: localIso(2026, 9, 29) })], rolling.window);

    const sentinel = sentinelOf(root)!;
    cross(watcherOf(sentinel)!, sentinel);
    rolling.finishAStep();

    // A NEW observer, on the same element: the sentinel never moved off screen, so nothing would
    // have fired again and the scroll would have ended in the middle of the year.
    const rearmed = watcherOf(sentinel);
    expect(rearmed).toBeDefined();
    cross(rearmed!, sentinel);
    expect(rolling.loadMore).toHaveBeenCalledTimes(2);
  });

  it('replaces the foot with a sentence once the horizon is reached, and stops watching', () => {
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 10, 30));
    const root = render([event({ id: 'sep', startsAt: localIso(2026, 9, 29) })], rolling.window);
    const sentinel = sentinelOf(root)!;

    rolling.reachHorizon();

    // A spinner that never resolves and a list that has genuinely ended look identical, and a
    // reader who cannot tell them apart keeps pulling at a list that is finished.
    expect(sentinelOf(root)).toBeNull();
    expect(root.textContent).toContain('12');
    expect(watcherOf(sentinel)).toBeUndefined();
  });
});

describe('CalendarScheduleList - the gutter speaks the reader language', () => {
  afterEach(() => setLocale('fr', { reload: false }));

  it('reads the weekday from the same locale as the month above it', () => {
    setLocale('en', { reload: false });
    const rolling = stubWindow(new Date(2026, 8, 28), new Date(2026, 8, 30));
    const root = render([event({ id: 'sep', startsAt: localIso(2026, 9, 29) })], rolling.window);

    // 29 September 2026 is a Tuesday. The heading read the locale and the weekday under it was
    // hard-coded `fr-FR`, so an English reader got `mar.` beneath "September 2026" - and the
    // heading is the half anybody looks at, which is why it was the half that was right.
    expect(root.querySelector('h3')?.textContent?.trim()).toBe('September 2026');
    expect(root.textContent).toContain('Tue');
    expect(root.textContent).not.toContain('mar.');
  });
});
