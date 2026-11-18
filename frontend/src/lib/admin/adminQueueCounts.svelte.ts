import { apiFetch } from '$lib/utils/apiFetch';
import { socialUrl } from '$lib/utils/apiUrl';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { connectivity } from '$lib/stores/connectivity.svelte';
import { onPeerNamesEnded } from '$lib/utils/users/peerNameDirectory';
import { Log } from '$lib/utils/Log';
import { currentUserId } from '$lib/stores/userState.svelte';
import { SessionExpiredError } from '$lib/stores/auth';
import { IdentitySplitError } from '$lib/stores/tokenIdentity.svelte';

/**
 * The admin queues a pending count is served for, by the key of their row in the admin registry
 * (`adminSections.ts`) - the server's `ADMIN_QUEUE_KEYS` (`AdminQueuesService`).
 */
export type AdminQueueKey = 'agenda' | 'moderation' | 'profile-corrections';

/**
 * The pending items of each queue the reader may ACT on, as `GET /api/moderation/admin-queues`
 * answers them. A queue the reader cannot open is ABSENT, never zero.
 */
export type AdminQueueCounts = Partial<Record<AdminQueueKey, number>>;

const KEYS: readonly AdminQueueKey[] = ['agenda', 'moderation', 'profile-corrections'];

/**
 * The socket frame the server sends the accounts that may act on a queue when an item enters or
 * leaves it (`AdminQueueSignal`). It carries nothing; the counts are asked afterwards.
 */
export const ADMIN_QUEUES_CHANGED_FRAME = 'admin.queues.changed';

let counts = $state<AdminQueueCounts>({});
/** The request on the wire, and the account it was sent for. */
let inFlight: { owner: string | null; sentIn: number; done: Promise<void> } | null = null;
/** A load was asked while one was on the wire: one more is sent when it lands (trailing). */
let askedAgain = false;
/**
 * Bumped by every end of an account: an answer sent under an older epoch is dropped, so a request in
 * flight at a sign-out never draws one account's queue sizes for the next.
 */
let epoch = 0;

/** A sign-out or a change of account: the counts leave with the account that could see them. */
onPeerNamesEnded(() => {
  epoch++;
  counts = {};
});

/**
 * Keeps only the known keys holding a whole non-negative count, so a malformed answer can draw no
 * badge and a key the client does not know (a queue added on the server first) is ignored.
 */
export function readAdminQueueCounts(body: unknown): AdminQueueCounts {
  const raw = (body as { counts?: Record<string, unknown> } | null)?.counts ?? {};
  const out: AdminQueueCounts = {};
  for (const key of KEYS) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value;
  }
  return out;
}

/**
 * THE ADMIN BADGES' ONE SOURCE (owner, 2026-11-18): the server's pending counts, re-asked rather than
 * kept, so a badge is right after a reload and the moment another admin handles an item. Every
 * badge reads it - the dashboard's Administration row and the bottom bar's dashboard place (the sum),
 * and each queue's row on the admin hub (its own count). docs/wiki/frontend/modules/admin.md,
 * "Pending counts and the admin notices".
 */
export const adminQueueCounts = {
  /** Each queue's pending count, absent for a queue the reader cannot act on. */
  get counts(): AdminQueueCounts {
    return counts;
  },
  /** What the Administration entry carries: the sum of the queues this reader can act on. */
  get total(): number {
    return KEYS.reduce((sum, key) => sum + (counts[key] ?? 0), 0);
  },
};

/**
 * Asks the server for the counts. A call made while one is on the wire for the SAME account is not
 * sent twice, but it is not answered by that request either - it may have left before the change the
 * caller just made committed - so ONE more request follows when it lands. An answer for another
 * account (a sign-out or switch meanwhile) is dropped. No answer keeps the counts drawn and is said
 * at debug - the next ask corrects them; a refusal is said at WARN and keeps them too, since a wrong
 * zero would hide waiting items; a session that ended is apiFetch's to report, said at debug here.
 */
export function loadAdminQueueCounts(): Promise<void> {
  const owner = currentUserId();
  if (inFlight && inFlight.owner === owner) {
    askedAgain = true;
    return inFlight.done;
  }
  const sentIn = epoch;
  const done = (async () => {
    try {
      const res = await apiFetch(`${socialUrl()}/api/moderation/admin-queues`);
      if (!res.ok) {
        Log.w('adminQueueCounts', `refused: HTTP ${res.status}, the badges keep their last counts`);
        return;
      }
      const body: unknown = await res.json();
      if (sentIn !== epoch || currentUserId() !== owner) {
        Log.d('adminQueueCounts', 'answer for an account that has ended: dropped');
        return;
      }
      counts = readAdminQueueCounts(body);
      Log.d('adminQueueCounts', 'loaded', counts);
    } catch (err) {
      if (isTransportFailure(err)) {
        Log.d('adminQueueCounts', 'no answer, the badges keep their last counts');
        return;
      }
      if (err instanceof SessionExpiredError || err instanceof IdentitySplitError) {
        Log.d('adminQueueCounts', 'the session ended, no counts asked');
        return;
      }
      console.error('[adminQueueCounts] load failed, the badges keep their last counts', err);
    } finally {
      if (inFlight?.sentIn === sentIn && inFlight.owner === owner) inFlight = null;
    }
    if (askedAgain && currentUserId() === owner && sentIn === epoch) {
      askedAgain = false;
      await loadAdminQueueCounts();
    }
  })();
  askedAgain = false;
  inFlight = { owner, sentIn, done };
  return done;
}

/**
 * Keeps the counts current while the reader may open `/admin` - TOLD, NEVER POLLED (lead,
 * 2026-11-18): the counts are asked at once, then again on each `admin.queues.changed` frame the
 * server sends when an item enters or leaves a queue this reader may act on (routed by
 * `handleChannelEvent`, which calls {@link loadAdminQueueCounts}), and on what a frame cannot cover:
 * the app coming back to the foreground and the link coming back (a frame sent while the socket was
 * down is never replayed). No timer. The CALLER decides when - the root layout runs it inside an
 * effect over the tier stores, so a tier published late starts it and an account that loses every
 * tier stops it. Returns the cleanup.
 */
export function followAdminQueueCounts(): () => void {
  void loadAdminQueueCounts();
  const onVisibility = () => {
    if (document.visibilityState !== 'visible') return;
    Log.d('adminQueueCounts', 'back in the foreground: counts asked again');
    void loadAdminQueueCounts();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  const stopReconnect = connectivity.onReconnect(() => {
    Log.d('adminQueueCounts', 'link back: counts asked again');
    void loadAdminQueueCounts();
  });
  return () => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    stopReconnect();
  };
}
