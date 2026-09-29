import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { PickerOption } from '$lib/components/ui/picker';

/** "3 min", "2 h", "4 j" / "4 d", or a short date for older entries. */
export function timeAgo(dateStr: string): string {
  const diffSec = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diffSec < 60) return m.time_just_now();
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return m.time_short_days({ count: d });
  return new Date(dateStr).toLocaleDateString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
    day: 'numeric',
    month: 'short',
  });
}

/** Full date + time, locale-aware: "12 mai 2026 à 14:30" / "May 12, 2026, 2:30 PM". */
export function exactDate(dateStr: string): string {
  return new Date(dateStr).toLocaleString(getLocale() === 'en' ? 'en-US' : 'fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The option label of a calendar event a post can be linked to: "12 mai 2026 14:30 - Gala".
 * One implementation for the composer and the editor, which each carried a copy.
 */
export function linkableEventLabel(ev: { startsAt: string; title: string }): string {
  const locale = getLocale() === 'en' ? 'en-US' : 'fr-FR';
  const d = new Date(ev.startsAt);
  const date = d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time} - ${ev.title}`;
}

/** The options of the "link to an event" picker: "no event" (or "loading") first, then each event. */
export function linkableEventPickerOptions(
  events: { id: string; startsAt: string; title: string }[],
  loading: boolean
): PickerOption[] {
  return [
    { value: '', label: loading ? m.common_loading_label() : m.post_create_no_event_label() },
    ...events.map((ev) => ({ value: ev.id, label: linkableEventLabel(ev) })),
  ];
}

/** "il y a 3 min" / "3 min ago", etc. */
export function formatRelative(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return m.time_just_now_lower();
  if (mins < 60) return m.time_minutes_ago({ count: mins });
  const h = Math.floor(mins / 60);
  if (h < 24) return m.time_hours_ago({ count: h });
  return m.time_days_ago({ count: Math.floor(h / 24) });
}
