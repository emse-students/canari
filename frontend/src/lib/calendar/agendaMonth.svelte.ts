import { onMount } from 'svelte';
import { SvelteDate } from 'svelte/reactivity';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
import { calendarDayOf } from '$lib/calendar/feedEvents';
import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import {
  SCHEDULE_AGENDA_QUERY,
  isScheduleAgendaViewport,
  onViewportChange,
} from '$lib/utils/viewport';

/** The bounds of one visible month, as the calendar endpoints want them. */
export interface MonthRangeISO {
  from: string;
  to: string;
}

/**
 * The visible month, as an ISO range covering it whole.
 *
 * Local midnight to local end-of-month, NOT UTC: the server is asked for the days this grid will
 * draw, and in a positive offset a UTC month start is the previous month's last evening - an event
 * the user can see a square for would be missing from the answer.
 */
export function monthRangeISO(d: Date): MonthRangeISO {
  // Both are pure locals: they are read once, immediately, and never reach state or a template, so
  // `prefer-svelte-reactivity` has nothing to protect here.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, never stored, never mutated
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local, never stored, never mutated
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * HOW FAR FORWARD THE PHONE'S AGENDA GOES, AND WHY IT ENDS AT ALL.
 *
 * A scroll that never terminates cannot tell "nothing more is planned" from "still loading", so the
 * window has a stated end and the list says so in words when it reaches it. Twelve months is the
 * range the `.ics` subscription already publishes (`icsSubscriptionRangeISO`) and the one the
 * backend falls back to when a feed URL carries no window - so this is the horizon the app already
 * had, now visible to the reader rather than only to the calendar app.
 */
export const ROLLING_HORIZON_MONTHS = 12;

/**
 * How much is fetched per step - THREE MONTHS, NOT ONE, and the unit is deliberate.
 *
 * The endpoints take an arbitrary range, so "a month" was never the fetch unit, only the grid's
 * drawing unit. A quiet period (July, August) would otherwise load one empty month per scroll tick
 * and the reader would be paying a round trip to be told nothing four times in a row; at three the
 * whole horizon is four requests and the first paint almost always has content in it.
 */
const ROLLING_CHUNK_MONTHS = 3;

/**
 * The range of one step of the rolling window, as the calendar endpoints want it.
 *
 * THE FIRST STEP STARTS AT `windowStart`, NOT AT THE FIRST OF ITS MONTH - that is the whole point
 * of the shape (user, 2026-09-20): on the 28th, a month-aligned agenda opens on 27 days that have
 * already happened. Every later step is month-aligned, because by then the window has left today
 * behind and a month boundary is where the list draws its headings.
 *
 * Both ends are inclusive of the days they name: the server's predicate is an OVERLAP, so an event
 * that began before the window and ends inside it is returned - which is what keeps a multi-day
 * event on the rows it covers rather than only on the one it started.
 *
 * Pure and explicitly dated, so a test may state the day it is standing on instead of asserting a
 * wall clock.
 */
export function rollingChunkRangeISO(
  windowStart: Date,
  loadedMonths: number,
  count: number
): MonthRangeISO {
  const year = windowStart.getFullYear();
  const month = windowStart.getMonth();
  // Three pure locals: serialised on the next line and never stored, so `prefer-svelte-reactivity`
  // has nothing to protect here - the same exemption `monthRangeISO` above carries.
  /* eslint-disable svelte/prefer-svelte-reactivity -- local, never stored, never mutated */
  const start =
    loadedMonths === 0
      ? new Date(year, month, windowStart.getDate(), 0, 0, 0, 0)
      : new Date(year, month + loadedMonths, 1, 0, 0, 0, 0);
  const end = new Date(year, month + loadedMonths + count, 0, 23, 59, 59, 999);
  /* eslint-enable svelte/prefer-svelte-reactivity */
  return { from: start.toISOString(), to: end.toISOString() };
}

/**
 * THE DAY THE READER IS CURRENTLY IN, which is not always the date on the wall clock.
 *
 * A calendar day here ends at 05:00 ({@link calendarDayOf}), so at 01:00 the reader is still inside
 * the evening that began yesterday - and a party running 23:00 to 02:00 is still ON. Opening the
 * window at plain local midnight would drop that row out from under someone who is at the event.
 *
 * It is read once per `reload()` and not re-derived on a timer: a list that re-anchors itself while
 * it is being scrolled moves the rows under the reader's thumb, which is worse than a phone left
 * open overnight showing one day it could have dropped.
 */
function currentCalendarDay(): Date {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- read once, returned, never mutated
  return calendarDayOf(new Date());
}

/**
 * The last day the loaded window covers - the end of the last month fetched.
 *
 * Zero loaded months answers with the day BEFORE the window starts, which is an empty range and
 * exactly what the list should draw before its first chunk lands.
 */
export function rollingWindowEnd(windowStart: Date, loadedMonths: number): Date {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a computed bound, replaced wholesale
  return new Date(
    windowStart.getFullYear(),
    windowStart.getMonth() + loadedMonths,
    0,
    23,
    59,
    59,
    999
  );
}

/**
 * Two windows of the same agenda merged, KEYED ON THE EVENT ID.
 *
 * Every chunk boundary re-delivers the events that straddle it, because the server's range
 * predicate is an overlap: a WEI running 31 October to 2 November is in both the chunk ending in
 * October and the one starting in November. Concatenating them puts one id in the list twice, and a
 * keyed `{#each}` over that does not paint a row twice - it throws `each_key_duplicate` and takes
 * the page down, which this module's neighbours have already shipped once (prod, 2026-09-14).
 *
 * The incoming copy wins: it is the fresher read of the same row.
 */
function mergeEventsById(
  current: AssociationCalendarFeedEvent[],
  incoming: AssociationCalendarFeedEvent[]
): AssociationCalendarFeedEvent[] {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local index, discarded on return
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()];
}

/** What a surface must supply: how ITS month is fetched. Everything else is the same everywhere. */
export interface AgendaMonthContext {
  /**
   * Fetches one month. THROWING is how a surface reports a failure - the error sentence is this
   * module's, because a load that failed reads the same on both surfaces and the two had drifted
   * to two different sentences for the same event.
   */
  load: (range: MonthRangeISO) => Promise<AssociationCalendarFeedEvent[]>;
}

/**
 * THE ROLLING WINDOW THE PHONE READS INSTEAD OF A MONTH.
 *
 * A month is the GRID's unit - it draws squares, so it needs a first and a last one. A list has no
 * such need, and inheriting the unit anyway is what made the agenda open on 27 days that had
 * already happened when it was read on the 28th (user, 2026-09-20). So below `md` the agenda starts
 * at TODAY and grows forward on scroll, with no month arrows and no way back: the past is a desktop
 * question, and the reader of a phone agenda is asking what is next.
 *
 * Nothing here exists in grid mode - `null` is how a surface knows which shape it is drawing.
 */
export interface AgendaRollingWindow {
  /** First day drawn: local midnight of the day the window was opened on. */
  readonly from: Date;
  /** Last day drawn - the end of the last chunk fetched. Grows with every step. */
  readonly to: Date;
  /** True once the horizon is reached: there is nothing further to ask for. */
  readonly complete: boolean;
  /** True while a further chunk is in flight - a footer spinner, never the whole-view one. */
  readonly loadingMore: boolean;
  /**
   * True when a step FAILED, which stops the automatic ones.
   *
   * An observer that re-fires on every scroll would turn one failing request into a stream of them,
   * so the reader is given the retry instead - the only thing that clears this.
   */
  readonly stalled: boolean;
  /** Asks for the next chunk. A no-op while one is in flight, stalled, or at the horizon. */
  loadMore(): void;
  /** Clears a stall and asks again. */
  retry(): void;
  /**
   * Tells the window which month the reader is actually looking at.
   *
   * `focusDate` DOES NOT STOP MEANING ANYTHING HERE, it stops being chosen by arrows: the PDF
   * export exports `focusDate`'s month, and a phone turned sideways mid-scroll gets the grid for
   * it. Both would otherwise be stuck on whatever month the window opened in.
   */
  setVisibleMonth(monthStart: Date): void;
}

/** One month of an agenda: what is shown, what is being looked at, and how to move between months. */
export interface AgendaMonthState {
  /** The month being drawn. Setting it does NOT reload - `reload()` is the surface's to call. */
  focusDate: Date;
  /** Day-of-month of the open day panel, or null. Cleared by every month change. */
  selectedDay: number | null;
  readonly events: AssociationCalendarFeedEvent[];
  readonly loading: boolean;
  /** Writable: a delete or a validation that failed belongs in the same banner as a failed load. */
  loadError: string;
  /** Visible month and year, locale-aware. */
  readonly titleMonth: string;
  /** True on a phone-width viewport, where the month grid is replaced by a schedule list. */
  readonly scheduleLayout: boolean;
  /** The rolling window, on a phone-width viewport - `null` while the grid is the shape. */
  readonly rolling: AgendaRollingWindow | null;
  detailEvent: AssociationCalendarFeedEvent | null;
  detailModalOpen: boolean;
  reload(): Promise<void>;
  prevMonth(): void;
  nextMonth(): void;
  openDetail(event: AssociationCalendarFeedEvent): void;
}

/**
 * THE MONTH EVERY AGENDA SURFACE DRAWS, AND THE ONLY IMPLEMENTATION OF IT.
 *
 * `/calendar` and an association's calendar tab are two views of one idea, and they were written
 * twice: the same six pieces of state, the same month arithmetic, the same locale-aware title, the
 * same phone-versus-grid rule with the same docblock copied under it, and the same detail-modal
 * pair. Nothing kept them in step, and they had already drifted - a failed load cleared the events
 * on one surface and left the previous month's on the other, under two different sentences.
 *
 * WHAT GENUINELY DIFFERS IS ONE FUNCTION: which endpoint answers for a month. One surface asks the
 * aggregated feed with a filter, the other asks one association. That is the argument; the rest is
 * here.
 *
 * A FAILED LOAD CLEARS THE MONTH. Leaving the previous answer on screen under an error banner
 * shows a month that is not the month the header names, and the reader has no way to tell which
 * squares are stale.
 */
export function createAgendaMonth(ctx: AgendaMonthContext): AgendaMonthState {
  let focusDate = $state<Date>(new SvelteDate());
  let selectedDay = $state<number | null>(null);
  let events = $state<AssociationCalendarFeedEvent[]>([]);
  let loading = $state(true);
  let loadError = $state('');
  let detailEvent = $state<AssociationCalendarFeedEvent | null>(null);
  let detailModalOpen = $state(false);

  const titleMonth = $derived(
    new Intl.DateTimeFormat(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
      month: 'long',
      year: 'numeric',
    }).format(focusDate)
  );

  /**
   * A PHONE GETS A SCHEDULE LIST INSTEAD OF THE MONTH GRID (user, 2026-09-09).
   *
   * Read at mount and kept in step with rotations rather than fixed once: the same window can be
   * both, and a device turned sideways must get the grid back rather than keep a layout chosen for
   * the width it used to have. `false` under SSR is the desktop answer by design - the mount that
   * follows corrects it.
   */
  let scheduleLayout = $state(false);
  onMount(() => {
    scheduleLayout = isScheduleAgendaViewport();
    return onViewportChange(SCHEDULE_AGENDA_QUERY, (narrow) => {
      if (narrow === scheduleLayout) return;
      scheduleLayout = narrow;
      /**
       * A ROTATION CHANGES THE WINDOW, NOT ONLY THE MARKUP, so it has to refetch.
       *
       * The two shapes hold different ranges - one month either side of the arrows, or today to the
       * horizon - and neither answers the other's question. Turning a phone sideways mid-scroll
       * would otherwise hand the grid a September built out of a year of events, and turning it
       * back would hand the list one month of them under a heading that promises twelve.
       */
      void reload();
    });
  });

  // ── The rolling window (schedule layout only) ─────────────────────────────
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- replaced wholesale, never mutated
  let windowStart = $state<Date>(currentCalendarDay());
  let loadedMonths = $state(0);
  let loadingMore = $state(false);
  let stalled = $state(false);

  const windowEnd = $derived(rollingWindowEnd(windowStart, loadedMonths));
  const windowComplete = $derived(loadedMonths >= ROLLING_HORIZON_MONTHS);

  /** How many months the next step may ask for - the chunk, clipped by the horizon. */
  function nextChunkSize(): number {
    return Math.min(ROLLING_CHUNK_MONTHS, ROLLING_HORIZON_MONTHS - loadedMonths);
  }

  /**
   * A FAILED LOAD CLEARS THE MONTH, and that stays true of the FIRST window too: leaving the
   * previous answer on screen under an error banner shows days that are not the days the view
   * promises, and the reader has no way to tell which rows are stale.
   *
   * A failed APPEND is the other case and is handled in `loadMore` - there the rows already drawn
   * are still exactly what they claim to be, so they stay.
   */
  async function reload(): Promise<void> {
    loading = true;
    loadError = '';
    stalled = false;
    if (scheduleLayout) {
      windowStart = currentCalendarDay();
      focusDate = new SvelteDate(windowStart.getTime());
      selectedDay = null;
      loadedMonths = 0;
    }
    try {
      if (scheduleLayout) {
        const count = nextChunkSize();
        events = await ctx.load(rollingChunkRangeISO(windowStart, 0, count));
        loadedMonths = count;
      } else {
        events = await ctx.load(monthRangeISO(focusDate));
      }
    } catch {
      loadError = m.common_load_error();
      events = [];
      loadedMonths = 0;
    } finally {
      loading = false;
    }
  }

  /** One step forward. Guarded rather than conditional at the call site: the observer fires often. */
  async function loadMore(): Promise<void> {
    if (!scheduleLayout || loading || loadingMore || stalled || windowComplete) return;
    loadingMore = true;
    const count = nextChunkSize();
    try {
      const chunk = await ctx.load(rollingChunkRangeISO(windowStart, loadedMonths, count));
      events = mergeEventsById(events, chunk);
      loadedMonths += count;
      loadError = '';
    } catch {
      loadError = m.common_load_error();
      stalled = true;
    } finally {
      loadingMore = false;
    }
  }

  const rolling: AgendaRollingWindow = {
    get from() {
      return windowStart;
    },
    get to() {
      return windowEnd;
    },
    get complete() {
      return windowComplete;
    },
    get loadingMore() {
      return loadingMore;
    },
    get stalled() {
      return stalled;
    },
    loadMore: () => void loadMore(),
    retry() {
      stalled = false;
      loadError = '';
      void loadMore();
    },
    setVisibleMonth(monthStart: Date) {
      if (!scheduleLayout) return;
      if (
        focusDate.getFullYear() === monthStart.getFullYear() &&
        focusDate.getMonth() === monthStart.getMonth()
      ) {
        return;
      }
      focusDate = new SvelteDate(monthStart.getFullYear(), monthStart.getMonth(), 1);
    },
  };

  /** Both arrows drop the open day panel: its number means nothing in the month being moved to. */
  function step(months: number): void {
    selectedDay = null;
    focusDate = new SvelteDate(focusDate.getFullYear(), focusDate.getMonth() + months, 1);
    void reload();
  }

  return {
    get focusDate() {
      return focusDate;
    },
    set focusDate(value: Date) {
      focusDate = value;
    },
    get selectedDay() {
      return selectedDay;
    },
    set selectedDay(value: number | null) {
      selectedDay = value;
    },
    get events() {
      return events;
    },
    get loading() {
      return loading;
    },
    get loadError() {
      return loadError;
    },
    set loadError(value: string) {
      loadError = value;
    },
    get titleMonth() {
      return titleMonth;
    },
    get scheduleLayout() {
      return scheduleLayout;
    },
    get rolling() {
      return scheduleLayout ? rolling : null;
    },
    get detailEvent() {
      return detailEvent;
    },
    set detailEvent(value: AssociationCalendarFeedEvent | null) {
      detailEvent = value;
    },
    get detailModalOpen() {
      return detailModalOpen;
    },
    set detailModalOpen(value: boolean) {
      detailModalOpen = value;
    },
    reload,
    prevMonth: () => step(-1),
    nextMonth: () => step(1),
    openDetail(event: AssociationCalendarFeedEvent) {
      detailEvent = event;
      detailModalOpen = true;
    },
  };
}
