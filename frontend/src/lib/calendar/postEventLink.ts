import { getCalendarEventLinkedToPost } from '$lib/associations/api';
import type { AgendaMonthState } from '$lib/calendar/agendaMonth.svelte';
import { Log } from '$lib/utils/Log';

/** The query parameter a post's event chip carries: the POST id, the only id the chip has. */
export const FROM_POST_PARAM = 'fromPost';

/** Reads `?fromPost=` from a URL, trimmed; `''` when absent. */
export function fromPostOf(url: { searchParams: { get(name: string): string | null } }): string {
  return url.searchParams.get(FROM_POST_PARAM)?.trim() ?? '';
}

/** Where a post's event chip leads: the global agenda, which opens the event from the post id. */
export function postEventHref(postId: string): string {
  return `/calendar?${FROM_POST_PARAM}=${encodeURIComponent(postId)}`;
}

/**
 * Opens, in an agenda's own detail modal, the event a post links to.
 *
 * The lookup is the server's reverse link, which respects the reader's visibility, so a post whose
 * event the reader cannot see opens nothing (debug line, agenda untouched). The modal opens
 * REGARDLESS of the agenda's active space or association filter: the reader followed a link to this
 * event, and a filter that hid it would make the link look broken.
 *
 * `showItsMonth` (the global agenda) first moves a month-grid layout to the event's month and
 * reloads, so the grid behind the modal shows the event; the caller must then NOT have started its
 * own first reload (two overlapping loads of different months race). The phone's rolling window
 * always starts today, so it is left alone.
 *
 * @returns true when an event was opened.
 */
export async function openEventLinkedToPost(
  agenda: AgendaMonthState,
  postId: string,
  opts: { showItsMonth?: boolean } = {}
): Promise<boolean> {
  try {
    const { linkedEvent } = await getCalendarEventLinkedToPost(postId);
    if (!linkedEvent) {
      Log.d(`[calendar] post ${postId} links no visible event`);
      return false;
    }
    if (opts.showItsMonth && !agenda.scheduleLayout) {
      const start = new Date(linkedEvent.startsAt);
      agenda.focusDate = new Date(start.getFullYear(), start.getMonth(), 1);
      agenda.selectedDay = null;
      await agenda.reload();
    }
    agenda.openDetail(linkedEvent);
    return true;
  } catch (err) {
    Log.d('[calendar] opening the event of a post failed', err);
    return false;
  }
}
