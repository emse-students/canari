/** RFC 5545 TEXT escaping for SUMMARY/DESCRIPTION/UID fragments. */
export function icsEscapeText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
}

function toDate(d: string | Date): Date {
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

export type AgendaExportEvent = {
  id: string;
  title: string;
  description?: string | null;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  /** Shown as URL property and appended to Google details when provided. */
  sourceUrl?: string;
};

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

/**
 * Builds a VCALENDAR document (UTC) suitable for Apple Calendar, Google import, and most Android apps.
 */
export function buildIcsCalendar(events: AgendaExportEvent[], opts?: { prodId?: string }): string {
  const prodId = opts?.prodId ?? '-//Canari//Agenda//FR';
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${icsEscapeText(prodId)}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  const now = new Date();
  for (const ev of events) {
    const start = toDate(ev.startsAt);
    if (Number.isNaN(start.getTime())) continue;
    const end = defaultEnd(start, ev.endsAt ?? null);
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${icsEscapeText(ev.id)}@canari`);
    lines.push(`DTSTAMP:${formatIcsUtc(now)}`);
    lines.push(`DTSTART:${formatIcsUtc(start)}`);
    lines.push(`DTEND:${formatIcsUtc(end)}`);
    lines.push(`SUMMARY:${icsEscapeText(ev.title)}`);
    if (ev.description?.trim()) {
      lines.push(`DESCRIPTION:${icsEscapeText(truncateDescription(ev.description))}`);
    }
    if (ev.sourceUrl?.trim()) {
      lines.push(`URL:${icsEscapeText(ev.sourceUrl.trim())}`);
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function formatGoogleUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Opens Google Calendar "create event" with the same times as the agenda row (template, not subscribed). */
export function googleCalendarTemplateUrl(ev: AgendaExportEvent): string {
  const start = toDate(ev.startsAt);
  if (Number.isNaN(start.getTime())) {
    return 'https://calendar.google.com/calendar/u/0/r';
  }
  const end = defaultEnd(start, ev.endsAt ?? null);
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: ev.title,
    dates: `${formatGoogleUtc(start)}/${formatGoogleUtc(end)}`,
  });
  let details = (ev.description ?? '').trim();
  if (ev.sourceUrl?.trim()) {
    details = details ? `${details}\n\n${ev.sourceUrl.trim()}` : ev.sourceUrl.trim();
  }
  if (details) params.set('details', details);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function downloadTextFile(filename: string, body: string, mime: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
