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
  /** The accepted co-organisers, in display order (D39); absent on a single-owner row. */
  coOwners?: Array<{ name: string }>;
};

/**
 * The organisers as ONE summary suffix - the SAME rule as the client's `organisersLabel`: the name
 * alone, `A + B` for two, `A + N autres` from three on (up to four associations may run an event).
 * An entry in a subscriber's calendar named only the owner and hid up to three co-organisers.
 * French because the feed is anonymous and carries no locale, like the rest of this file's output.
 */
export function organisersSummary(owners: string[]): string {
  if (owners.length <= 2) return owners.join(' + ');
  return `${owners[0]} + ${owners.length - 1} autres`;
}

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
    summary: `${r.title} - ${organisersSummary([r.associationName, ...(r.coOwners ?? []).map((co) => co.name)].filter((n) => n.trim() !== ''))}`,
    startsAt: r.startsAt,
    endsAt: r.endsAt,
    description: r.description,
    url: `${base}/associations/${encodeURIComponent(r.associationSlug)}`,
  }));
  return buildIcsDocument(events);
}
