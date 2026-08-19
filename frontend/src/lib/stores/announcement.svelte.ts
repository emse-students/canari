import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { getClientAppVersion } from '$lib/utils/appVersion';
import { getLocale } from '$lib/paraglide/runtime';

/** What the server hands over: both languages, so this layer picks. */
export type PlatformAnnouncement = {
  id: string;
  titleFr: string;
  titleEn: string;
  bodyFr: string;
  bodyEn: string;
};

/** The announcement in the language the user chose inside Canari. */
export type LocalizedAnnouncement = {
  id: string;
  title: string;
  body: string;
};

let pending = $state<PlatformAnnouncement | null>(null);
/** One fetch per app opening, and only ever one in flight. */
let checked = false;

/** Parses the endpoint's JSON, rejecting anything that would render as a blank modal. */
export function parseAnnouncement(raw: unknown): PlatformAnnouncement | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const fields = ['id', 'titleFr', 'titleEn', 'bodyFr', 'bodyEn'] as const;
  for (const f of fields) {
    if (typeof o[f] !== 'string' || !(o[f] as string).trim()) return null;
  }
  return {
    id: o.id as string,
    titleFr: o.titleFr as string,
    titleEn: o.titleEn as string,
    bodyFr: o.bodyFr as string,
    bodyEn: o.bodyEn as string,
  };
}

/** Picks the half matching the app's locale. Never a fallback: both halves are always stored. */
export function localizeAnnouncement(
  a: PlatformAnnouncement,
  locale: string
): LocalizedAnnouncement {
  const en = locale === 'en';
  return {
    id: a.id,
    title: en ? a.titleEn : a.titleFr,
    body: en ? a.bodyEn : a.bodyFr,
  };
}

/** The announcement to show right now, already localized, or `null`. */
export function getPendingAnnouncement(): LocalizedAnnouncement | null {
  return pending ? localizeAnnouncement(pending, getLocale()) : null;
}

/**
 * Asks once per app opening whether this ACCOUNT has an announcement waiting.
 *
 * The client version travels as a query parameter because nothing else in the request carries it,
 * and the server owns the range comparison: a client outside an announcement's range must never
 * learn that one exists and was withheld, which it would if this filtered locally.
 *
 * A failure is not retried. An announcement is a decoration; the standing rule is that an optional
 * decoration which cannot be fetched degrades rather than errors, and the state that matters is
 * server-side, so the next app opening asks again and loses nothing.
 *
 * IT IS NOT SILENT, THOUGH, AND THAT COST A FEATURE. "No announcement" is a 200 carrying `null`.
 * Any other status means the ASK failed, which is a different fact and the only one a reader can
 * act on - yet both were reported the same way, at `debug`. `/api/users/announcement` was being
 * captured by `/api/users/:id` and answered 404 on every opening, for weeks, and the line saying so
 * was indistinguishable from the ordinary quiet case. A status that is not 200 is now ACCUSED.
 */
export async function refreshAnnouncement(): Promise<void> {
  if (checked) return;
  checked = true;
  try {
    const url = `${coreUrl()}/api/users/me/announcement?clientVersion=${encodeURIComponent(getClientAppVersion())}`;
    const res = await apiFetch(url);
    if (!res.ok) {
      console.error(
        `[announcement] the announcement endpoint refused: HTTP ${res.status} on ${url}`
      );
      return;
    }
    pending = parseAnnouncement(await res.json());
    if (pending) console.debug(`[announcement] showing ${pending.id}`);
  } catch (e) {
    console.debug('[announcement] fetch failed, will ask again next opening:', e);
  }
}

/**
 * Closes the modal and tells the server this account has read it.
 *
 * The local state is cleared FIRST and unconditionally: the button must close the dialog even when
 * the network does not answer. The durable half is the server's row, so a lost call means the
 * announcement returns at the next opening - visibly wrong, rather than silently unrecorded.
 */
export async function dismissAnnouncement(): Promise<void> {
  const announcement = pending;
  pending = null;
  if (!announcement) return;
  try {
    const res = await apiFetch(
      `${coreUrl()}/api/users/me/announcement/${encodeURIComponent(announcement.id)}/seen`,
      { method: 'POST' }
    );
    if (!res.ok) {
      console.warn(
        `[announcement] could not record ${announcement.id} as seen: HTTP ${res.status}`
      );
    }
  } catch (e) {
    console.warn(`[announcement] could not record ${announcement.id} as seen:`, e);
  }
}

/** Forgets everything, so the next account to sign in is asked on its own behalf. */
export function resetAnnouncementState(): void {
  pending = null;
  checked = false;
}
