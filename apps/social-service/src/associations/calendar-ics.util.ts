/** RFC 5545 TEXT escaping for SUMMARY/DESCRIPTION/UID fragments. */
export function icsEscapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function formatIcsUtc(dt: Date): string {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dt.getUTCDate()).padStart(2, '0');
  const h = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  const s = String(dt.getUTCSeconds()).padStart(2, '0');
  return `${y}${m}${day}T${h}${min}${s}Z`;
}

function toDate(d: string | Date): Date {
  return typeof d === 'string' ? new Date(d) : d;
}

function defaultEnd(start: Date, endRaw: string | Date | null | undefined): Date {
  if (endRaw === null || endRaw === undefined) return new Date(start.getTime() + 60 * 60 * 1000);
  const end = toDate(endRaw);
  if (Number.isNaN(end.getTime()) || end <= start) {
    return new Date(start.getTime() + 60 * 60 * 1000);
  }
  return end;
}

function truncateDescription(s: string, max = 450): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

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
 */
export function buildAggregatedCalendarIcs(
  rows: AggregatedCalendarIcsRow[],
  opts: { frontendBaseUrl: string }
): string {
  const base = opts.frontendBaseUrl.replace(/\/+$/, '');
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${icsEscapeText('-//Canari//Agenda//FR')}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const now = new Date();
  for (const r of rows) {
    const start = toDate(r.startsAt);
    if (Number.isNaN(start.getTime())) continue;
    const end = defaultEnd(start, r.endsAt ?? null);
    const summary = `${r.title} — ${r.associationName}`;
    const sourceUrl = `${base}/associations/${encodeURIComponent(r.associationSlug)}`;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscapeText(r.id)}@canari`);
    lines.push(`DTSTAMP:${formatIcsUtc(now)}`);
    lines.push(`DTSTART:${formatIcsUtc(start)}`);
    lines.push(`DTEND:${formatIcsUtc(end)}`);
    lines.push(`SUMMARY:${icsEscapeText(summary)}`);
    if (r.description?.trim()) {
      lines.push(`DESCRIPTION:${icsEscapeText(truncateDescription(r.description))}`);
    }
    lines.push(`URL:${icsEscapeText(sourceUrl)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
