/**
 * RFC 5545, ONE IMPLEMENTATION - COPIED WHOLESALE INTO THE CLIENT AND INTO `social-service`.
 *
 * Two places in this project turn events into a calendar file: the client, when someone taps
 * "add to my calendar", and `social-service`, which serves the subscribable feed an association's
 * agenda is published as. They must produce the SAME event - the same UID, the same UTC stamps,
 * the same escaping, the same one-hour default when an event has no end - because a person can
 * import one and subscribe to the other, and a divergence gives them two calendar entries for one
 * evening, or one that drifts.
 *
 * Until 2026-09-16 they shared nothing: five helpers and the whole VEVENT emission loop existed
 * twice, byte for byte, and nothing said so. `undeclared-duplicates.test.mjs` found them on the
 * day it was written.
 *
 * WHY A COPY RATHER THAN A SHARED PACKAGE: the same reason `cors-origins.ts` gives, and this file
 * follows its shape exactly. There is no shared TypeScript package here; `libs/shared-ts` existed,
 * was imported by nothing and was deleted on 2026-08-27, and creating one for eighty lines would
 * add a build stage and the `--install-links` trap to four production images. So the two copies
 * are declared in `.github/scripts/lib/declared-duplicates.mjs` and compared byte for byte by CI.
 *
 * THIS FILE THEREFORE IMPORTS NOTHING. An import would resolve differently on the two sides and
 * the copies could no longer be identical.
 *
 * KEEP IN SYNC is not a hope here: the group is declared in
 * `.github/scripts/lib/declared-duplicates.mjs` and CI compares the copies byte for byte.
 */

/** RFC 5545 TEXT escaping for SUMMARY/DESCRIPTION/UID fragments. */
export function icsEscapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

/** Accepts both shapes a row reaches us in: an ISO string from the API, a Date from the caller. */
export function toIcsDate(d: string | Date): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

/** UTC form `YYYYMMDDTHHmmssZ` for iCalendar DATE-TIME. */
export function formatIcsUtc(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  const h = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  const s = String(dt.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

/**
 * An event with no usable end lasts one hour.
 *
 * A missing end, an unparseable one and one that is not after the start are the SAME case here:
 * a VEVENT whose DTEND is not after its DTSTART is rejected outright by some clients and silently
 * collapsed by others, so there is nothing to gain by telling them apart.
 */
export function icsEndOrDefault(start: Date, endRaw: string | Date | null | undefined): Date {
  if (endRaw === null || endRaw === undefined) return new Date(start.getTime() + 60 * 60 * 1000);
  const end = toIcsDate(endRaw);
  if (Number.isNaN(end.getTime()) || end <= start) {
    return new Date(start.getTime() + 60 * 60 * 1000);
  }
  return end;
}

/** DESCRIPTION is folded by the client anyway; past this length it is nobody's agenda entry. */
export function truncateIcsDescription(s: string, max = 450): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\u2026`;
}

/** One calendar entry, in the raw shape both sides hold before any RFC 5545 rule is applied. */
export type IcsEvent = {
  /** Made unique per event; the `@canari` domain is appended here, not by the caller. */
  uid: string;
  summary: string;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  description?: string | null;
  /** The URL property, and where a client sends someone who taps the entry. */
  url?: string | null;
};

/** The product identifier both sides announce, so an imported file and a feed look like one source. */
export const ICS_PROD_ID = '-//Canari//Agenda//FR';

/**
 * Builds a VCALENDAR document (UTC) suitable for Apple Calendar, Google import and Android.
 *
 * AN EVENT WITH AN UNREADABLE START IS SKIPPED, not defaulted. Every other field has a sensible
 * absence - no end means an hour, no description means no line - but a start does not: writing a
 * guess into someone's calendar is worse than writing nothing.
 */
export function buildIcsDocument(events: IcsEvent[], prodId: string = ICS_PROD_ID): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${icsEscapeText(prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const now = new Date();
  for (const ev of events) {
    const start = toIcsDate(ev.startsAt);
    if (Number.isNaN(start.getTime())) continue;
    const end = icsEndOrDefault(start, ev.endsAt ?? null);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscapeText(ev.uid)}@canari`);
    lines.push(`DTSTAMP:${formatIcsUtc(now)}`);
    lines.push(`DTSTART:${formatIcsUtc(start)}`);
    lines.push(`DTEND:${formatIcsUtc(end)}`);
    lines.push(`SUMMARY:${icsEscapeText(ev.summary)}`);
    if (ev.description?.trim()) {
      lines.push(`DESCRIPTION:${icsEscapeText(truncateIcsDescription(ev.description))}`);
    }
    if (ev.url?.trim()) {
      lines.push(`URL:${icsEscapeText(ev.url.trim())}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
