import { buildIcsDocument, type IcsEvent } from './ics';

/** One aggregated agenda row as the feed query returns it. */
export type AggregatedCalendarIcsRow = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  associationName: string;
  associationSlug: string;
};

/**
 * Builds a VCALENDAR (UTC) for aggregated association agenda rows.
 * `frontendBaseUrl` is used for per-event URL (association page).
 *
 * Every RFC 5545 decision is in `ics.ts`, which the client carries a byte-identical copy of: a
 * feed someone subscribes to here and a file they export there must describe the same evening.
 * What is decided HERE is only what an aggregated feed adds - the association's name in the
 * summary, since a subscriber sees every association at once and a bare title says whose it is.
 */
export function buildAggregatedCalendarIcs(
  rows: AggregatedCalendarIcsRow[],
  opts: { frontendBaseUrl: string }
): string {
  const base = opts.frontendBaseUrl.replace(/\/+$/, '');
  const events: IcsEvent[] = rows.map((r) => ({
    uid: r.id,
    summary: `${r.title} - ${r.associationName}`,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    description: r.description,
    url: `${base}/associations/${encodeURIComponent(r.associationSlug)}`,
  }));
  return buildIcsDocument(events);
}
