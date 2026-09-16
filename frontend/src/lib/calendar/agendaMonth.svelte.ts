import { onMount } from 'svelte';
import { SvelteDate } from 'svelte/reactivity';
import type { AssociationCalendarFeedEvent } from '$lib/associations/api';
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

/** What a surface must supply: how ITS month is fetched. Everything else is the same everywhere. */
export interface AgendaMonthContext {
  /**
   * Fetches one month. THROWING is how a surface reports a failure - the error sentence is this
   * module's, because a load that failed reads the same on both surfaces and the two had drifted
   * to two different sentences for the same event.
   */
  load: (range: MonthRangeISO) => Promise<AssociationCalendarFeedEvent[]>;
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
    return onViewportChange(SCHEDULE_AGENDA_QUERY, (narrow) => (scheduleLayout = narrow));
  });

  async function reload(): Promise<void> {
    loading = true;
    loadError = '';
    try {
      events = await ctx.load(monthRangeISO(focusDate));
    } catch {
      loadError = m.common_load_error();
      events = [];
    } finally {
      loading = false;
    }
  }

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
