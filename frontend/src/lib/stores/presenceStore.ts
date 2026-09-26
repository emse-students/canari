import { get, writable } from 'svelte/store';
import { apiFetch } from '$lib/utils/apiFetch';
import { gatewayUrl } from '$lib/utils/apiUrl';
import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';

/**
 * Svelte store mapping each watched user ID to a boolean indicating whether
 * that user is currently online. Updated every 10 seconds by the polling loop.
 */
export const presenceMap = writable<Record<string, boolean>>({});
const peerIdsToPoll = new Set<string>();
let _destroyInterval: (() => void) | null = null;

/**
 * The poll currently running, or null.
 *
 * Without it a slow link stacks polls: the 10 s interval fires again while the previous request is
 * still open, and each one was measured at 32 s on a bad connection - four or five concurrent
 * `/api/presence` calls asking the identical question. Concurrent callers are COALESCED onto the
 * running request rather than turned away, so `await checkPresenceNow()` still means "presence is
 * fresh" for everyone. The watchlist may have grown meanwhile and the answer then covers the older
 * set; the next tick corrects it, which is cheaper than a request per subscription.
 */
let inFlight: Promise<void> | null = null;

/** Callbacks notified when at least one watched user went from offline to online. */
const cameOnlineListeners = new Set<(userIds: string[]) => void>();

/**
 * Registers a callback fired once per poll in which watched users came back ONLINE, with those
 * users. Returns its own unregister function.
 *
 * A transition is the signal worth acting on: work that was skipped because nobody was reachable
 * (soliciting history, above all) otherwise waits for its own timer or for the next reconnect,
 * although the client learnt the peer was back within ten seconds.
 */
export function onPeersCameOnline(fn: (userIds: string[]) => void): () => void {
  cameOnlineListeners.add(fn);
  return () => cameOnlineListeners.delete(fn);
}

/**
 * Calls `fn` ONCE, the first time one of `userIds` is seen online AFTER this call, then detaches.
 * Returns a cancel function.
 *
 * **Measured against the map as it stands at registration, not against the previous poll** - which
 * is what {@link onPeersCameOnline} reads, and why it cannot serve a caller that has just learnt
 * from elsewhere (a server roster) that these users are offline. A user this client has never
 * polled has no previous value, so their first poll answering `true` is no edge there and the
 * caller would wait for ever on someone already back. Here, a user not known online at
 * registration counts as back the moment the map says so. A user the map still calls online - a
 * value up to one poll stale, contradicting the caller's own fresher read - must be seen offline
 * first, so a stale `true` can never fire a retry that finds them offline again and re-registers.
 *
 * Starts polling them, and never stops: the watchlist is shared with the UI and not reference
 * counted, so unwatching here could silence a presence dot a component still shows.
 */
export function whenAnyComesOnline(userIds: string[], fn: (userIds: string[]) => void): () => void {
  const ids = [...new Set(userIds.filter(Boolean))];
  const before = get(presenceMap);
  const armed = new Set(ids.filter((id) => before[id] !== true));
  const seenOnline = new Set(ids.filter((id) => before[id] === true));
  let done = false;
  let unsubscribe: (() => void) | null = null;
  const detach = () => {
    done = true;
    unsubscribe?.();
  };
  unsubscribe = presenceMap.subscribe((map) => {
    if (done) return;
    for (const id of seenOnline) {
      if (map[id] === false) {
        seenOnline.delete(id);
        armed.add(id);
      }
    }
    const back = [...armed].filter((id) => map[id] === true);
    if (back.length === 0) return;
    detach();
    try {
      fn(back);
    } catch (err) {
      console.warn('Presence waiter threw', err);
    }
  });
  watchUsers(ids);
  return detach;
}

/**
 * Adds the given user IDs to the polling watchlist and starts the polling loop
 * if it is not already running. The loop automatically pauses when the page is
 * hidden and resumes when visible.
 *
 * Call `unwatchUsers` with the same IDs when the component unmounts to prevent
 * the watched set from growing unbounded across navigations.
 */
export function watchUsers(userIds: string[]) {
  userIds.forEach((id) => {
    if (id) peerIdsToPoll.add(id);
  });
  if (!_destroyInterval) {
    _destroyInterval = createPausableInterval(checkPresenceNow, 10_000);
  }
}

/**
 * Removes the given user IDs from the polling watchlist. When the set becomes
 * empty the interval is stopped entirely (saves battery when no presence is needed).
 */
export function unwatchUsers(userIds: string[]) {
  userIds.forEach((id) => peerIdsToPoll.delete(id));
  if (peerIdsToPoll.size === 0 && _destroyInterval) {
    _destroyInterval();
    _destroyInterval = null;
  }
}

/** Returns `true` if the given user is currently marked as online in the local presence map. */
export function isUserOnline(userId: string): boolean {
  return get(presenceMap)[userId] || false;
}

/**
 * Immediately fetches presence status for all watched users from the gateway and
 * merges the result into `presenceMap`. Silently skips non-JSON or 401 responses.
 *
 * At most one request is in flight at a time: see {@link inFlight}.
 */
export async function checkPresenceNow(): Promise<void> {
  if (peerIdsToPoll.size === 0) return;
  if (inFlight) return inFlight;
  inFlight = pollPresence().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function pollPresence(): Promise<void> {
  const usersStr = Array.from(peerIdsToPoll).join(',');
  try {
    const baseUrl = gatewayUrl();
    const res = await apiFetch(`${baseUrl}/api/presence?users=${usersStr}`);
    if (res.ok) {
      const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.includes('application/json')) {
        console.warn('Presence endpoint returned non-JSON response, skipping update.');
        return;
      }
      const data = await res.json();
      // Only replace the map object when at least one value actually changed,
      // preventing cascading re-renders on every poll when statuses are stable.
      let cameOnline: string[] = [];
      presenceMap.update((prev) => {
        // An offline -> online EDGE, not the level: a user already known to be online says nothing
        // new, and a user we have never seen before is not "back" either.
        cameOnline = Object.keys(data).filter((k) => data[k] === true && prev[k] === false);
        const hasChange = Object.keys(data).some((k) => prev[k] !== data[k]);
        return hasChange ? { ...prev, ...data } : prev;
      });
      if (cameOnline.length > 0) notifyCameOnline(cameOnline);
      return;
    }
    if (res.status !== 401) {
      console.warn(`Presence request failed with status ${res.status}.`);
    }
  } catch (err) {
    console.error('Failed to fetch presence', err);
  }
}

/** Isolated per listener: one throwing subscriber must not swallow the notification for the rest. */
function notifyCameOnline(userIds: string[]): void {
  for (const fn of cameOnlineListeners) {
    try {
      fn(userIds);
    } catch (err) {
      console.warn('Presence listener threw', err);
    }
  }
}

/** @internal Resets module state between Vitest cases. */
export function resetPresenceForTests(): void {
  peerIdsToPoll.clear();
  cameOnlineListeners.clear();
  inFlight = null;
  presenceMap.set({});
  if (_destroyInterval) {
    _destroyInterval();
    _destroyInterval = null;
  }
}
