import { m } from '$lib/paraglide/messages';
import { getLocale } from '$lib/paraglide/runtime';
import type { MailAddress } from './mailTypes';

/**
 * HOW THE MAIL SCREENS WRITE A DATE, A SENDER AND A LIST'S SEARCH
 * (docs/wiki/mail-client-transport.md#as-built---lot-3). Pure: the clock is a parameter, the words
 * are Paraglide's, the locale the app's.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight of `ms`'s day, local time. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * A list row's date, as the mockups draw it: the time today, "Hier", the weekday within the week,
 * the day and month within the year, the full date before.
 */
export function mailListDate(ms: number, now: number): string {
  const locale = getLocale();
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) {
    return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(ms);
  }
  if (days === 1) return m.mail_date_yesterday();
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(ms);
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat(
    locale,
    sameYear ? { day: 'numeric', month: 'short' } : { dateStyle: 'short' }
  ).format(ms);
}

/** A message's full date and time, for the reader. */
export function mailFullDate(ms: number): string {
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    ms
  );
}

/** The name a person is shown by: the display name, else the address's local part. */
export function displayNameOf(address: MailAddress): string {
  if (address.name?.trim()) return address.name.trim();
  const at = address.address.lastIndexOf('@');
  return at > 0 ? address.address.slice(0, at) : address.address;
}

/** Whether `address` is the account itself (its address or one of its aliases). */
export function isSelf(address: MailAddress, self: readonly string[]): boolean {
  const key = address.address.toLowerCase();
  return self.some((s) => s.toLowerCase() === key);
}

/**
 * A row's senders, newest first as Zimbra lists them: "BDE, Camille, moi" - the account itself is
 * "moi", each person once, at most three names.
 */
export function sendersLine(senders: readonly MailAddress[], self: readonly string[]): string {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const sender of senders) {
    const key = sender.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(isSelf(sender, self) ? m.mail_sender_me() : displayNameOf(sender));
    if (names.length === 3) break;
  }
  return names.length ? names.join(', ') : m.mail_sender_unknown();
}

/** The quick filters of a list (the pills above it): each one a Zimbra search term. */
export type MailListFilter = 'all' | 'unread' | 'flagged' | 'attachment';

/** Every filter, in the order the pills draw them. */
export const MAIL_LIST_FILTERS: readonly MailListFilter[] = [
  'all',
  'unread',
  'flagged',
  'attachment',
];

const FILTER_TERMS: Readonly<Record<MailListFilter, string>> = {
  all: '',
  unread: 'is:unread',
  flagged: 'is:flagged',
  attachment: 'has:attachment',
};

/**
 * The query a list is searched with: the reader's words, ANDed with the filter's term. The words
 * are Zimbra's own syntax (plain words, or `from:`, `subject:` as typed); the store's request builder
 * keeps them inside the folder's scope.
 */
export function mailListQuery(search: string, filter: MailListFilter): string {
  return [search.trim(), FILTER_TERMS[filter]].filter(Boolean).join(' ');
}

/** The characters a saved name never keeps: control characters and the drive/stream separator. */
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const UNSAFE_NAME_CHARACTERS = /[\u0000-\u001f\u007f:]/g;

/**
 * The name an attachment is SAVED under: the sender's filename reduced to a bare basename. The name
 * is written by a stranger, and a save dialog or a download takes it as a path hint - so every
 * directory part (`/`, `\`), drive or stream separator (`:`), control character and leading dot (a
 * hidden or `..` name) is removed. Nothing left gives the generic "attachment" name.
 */
export function attachmentFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  const cleaned = base
    .replace(UNSAFE_NAME_CHARACTERS, '')
    .replace(/^[\s.]+/, '')
    .trim();
  return cleaned || m.mail_attachment_unnamed();
}
