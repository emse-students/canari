import { downloadDecryptedFile } from '$lib/utils/fileDownload';
import { buildIcsDocument, icsEndOrDefault, toIcsDate, type IcsEvent } from '$lib/calendar/ics';

export { formatIcsUtc, icsEscapeText } from '$lib/calendar/ics';

/** One agenda row as the client holds it, before it becomes a calendar entry. */
export type AgendaExportEvent = {
  id: string;
  title: string;
  description?: string | null;
  startsAt: string | Date;
  endsAt?: string | Date | null;
  /** Shown as URL property and appended to Google details when provided. */
  sourceUrl?: string;
};

/** The client's rows in the shape `ics.ts` speaks - the only thing this module adds to the RFC. */
function toIcsEvent(ev: AgendaExportEvent): IcsEvent {
  return {
    uid: ev.id,
    summary: ev.title,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt ?? null,
    description: ev.description ?? null,
    url: ev.sourceUrl ?? null,
  };
}

/**
 * Builds a VCALENDAR document (UTC) suitable for Apple Calendar, Google import, and most Android apps.
 *
 * Every RFC 5545 decision is in `ics.ts`, which `social-service` carries a byte-identical copy of:
 * a file someone imports here and a feed they subscribe to there must describe the same evening.
 */
export function buildIcsCalendar(events: AgendaExportEvent[], opts?: { prodId?: string }): string {
  const icsEvents = events.map(toIcsEvent);
  return opts?.prodId ? buildIcsDocument(icsEvents, opts.prodId) : buildIcsDocument(icsEvents);
}

function formatGoogleUtc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

/** Opens Google Calendar "create event" with the same times as the agenda row (template, not subscribed). */
export function googleCalendarTemplateUrl(ev: AgendaExportEvent): string {
  const start = toIcsDate(ev.startsAt);
  if (Number.isNaN(start.getTime())) {
    return 'https://calendar.google.com/calendar/u/0/r';
  }
  const end = icsEndOrDefault(start, ev.endsAt ?? null);
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

/**
 * Saves a generated text file (an .ics, in practice). Goes through `fileDownload` because an
 * anchor download is a no-op inside the Tauri WebView on both mobile platforms.
 */
export function downloadTextFile(filename: string, body: string, mime: string) {
  void downloadDecryptedFile(new Blob([body], { type: mime }), filename);
}
