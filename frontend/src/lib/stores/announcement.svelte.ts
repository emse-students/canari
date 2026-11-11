import { apiFetch } from '$lib/utils/apiFetch';
import { coreUrl } from '$lib/utils/apiUrl';
import { getClientAppVersion } from '$lib/utils/appVersion';
import { getLocale } from '$lib/paraglide/runtime';
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';

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
/**
 * Which account's ask an answer belongs to: {@link resetAnnouncementState} moves it on, so an ask
 * still in flight when its account signs out cannot land its announcement for the next one.
 */
let generation = 0;
/** The account the latch was taken for: whose device copy a dismissal drops. */
let account: string | null = null;
/** Ids closed in this process: an answer computed before the "seen" landed must not reopen one. */
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- nothing renders it; `pending` is the state
const dismissedHere = new Set<string>();

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
export async function refreshAnnouncement(userId: string): Promise<void> {
  if (checked) return;
  checked = true;
  account = userId;
  const asked = generation;
  const clientVersion = getClientAppVersion();
  // DRAWN FROM THE DEVICE FIRST (slow-link chantier, gap 1, 2026-11-11): the ask below needs a token,
  // and a cold start's token is the session refresh - 4 s on the owner's link, server 17 ms.
  const held = readHeldAnnouncement(userId, clientVersion);
  if (held && !dismissedHere.has(held.id)) {
    pending = held;
    console.debug(`[announcement] showing ${held.id} from the device copy, asking the server`);
  }
  try {
    const url = `${coreUrl()}/api/users/me/announcement?clientVersion=${encodeURIComponent(clientVersion)}`;
    const res = await apiFetch(url);
    if (asked !== generation) {
      console.debug('[announcement] dropped an answer that belongs to the account that signed out');
      return;
    }
    if (!res.ok) {
      console.error(
        `[announcement] the announcement endpoint refused: HTTP ${res.status} on ${url}`
      );
      return;
    }
    // The envelope is what makes "no announcement" parseable at all - see the controller.
    const body = (await res.json()) as { announcement?: unknown } | null;
    if (asked !== generation) {
      console.debug('[announcement] dropped an answer that belongs to the account that signed out');
      return;
    }
    const answer = parseAnnouncement(body?.announcement ?? null);
    // The server's answer replaces the copy - including with nothing (read on another device, or
    // withdrawn). One closed here meanwhile stays closed: its "seen" may not have landed yet.
    pending = answer && !dismissedHere.has(answer.id) ? answer : null;
    holdAnnouncement(userId, clientVersion, pending);
    if (pending) console.debug(`[announcement] showing ${pending.id}`);
    else if (held) console.debug(`[announcement] the server no longer lists ${held.id} - closed`);
  } catch (e) {
    console.debug(
      `[announcement] fetch failed, will ask again next opening (device copy ${held ? `${held.id} kept` : 'none'}):`,
      e
    );
  }
}

/** The copy kept on the device: the server's last answer, and the client version it was asked for. */
type HeldAnnouncement = { clientVersion: string; announcement: PlatformAnnouncement };

/**
 * The announcement held for `userId`, or `null`. ONLY THE CLIENT VERSION THAT ASKED may draw it: the
 * server owns the range comparison, so a copy asked by another version says nothing about this one.
 */
function readHeldAnnouncement(userId: string, clientVersion: string): PlatformAnnouncement | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY.pendingAnnouncement(userId));
    if (!raw) return null;
    const held = JSON.parse(raw) as Partial<HeldAnnouncement> | null;
    if (held?.clientVersion !== clientVersion) {
      console.debug(
        '[announcement] the device copy was asked by another client version - not drawn'
      );
      return null;
    }
    return parseAnnouncement(held.announcement ?? null);
  } catch (e) {
    console.warn('[announcement] the device copy could not be read - the server decides', e);
    return null;
  }
}

/** Keeps (or, with `null`, drops) the device copy of `userId`'s pending announcement. */
function holdAnnouncement(
  userId: string,
  clientVersion: string,
  announcement: PlatformAnnouncement | null
): void {
  try {
    const key = ACCOUNT_KEY.pendingAnnouncement(userId);
    if (!announcement) {
      localStorage.removeItem(key);
      return;
    }
    const held: HeldAnnouncement = { clientVersion, announcement };
    localStorage.setItem(key, JSON.stringify(held));
  } catch (e) {
    console.warn('[announcement] the device copy could not be written', e);
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
  dismissedHere.add(announcement.id);
  // The device copy goes with it: the next opening draws nothing until the server says otherwise.
  if (account) holdAnnouncement(account, getClientAppVersion(), null);
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

/**
 * Forgets everything, so the next account to sign in is asked on its own behalf. Called by
 * `endSessionImpl` (`sessionAuth.ts`, run by every sign-out): the latch and the pending
 * announcement belong to the account leaving the tab.
 */
export function resetAnnouncementState(): void {
  console.debug(
    `[announcement] state reset at sign-out (was ${pending ? `holding ${pending.id}` : 'empty'})`
  );
  pending = null;
  checked = false;
  account = null;
  dismissedHere.clear();
  generation += 1;
}
