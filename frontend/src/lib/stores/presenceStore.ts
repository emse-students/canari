import { get, writable } from 'svelte/store';
import { serverPresencePost } from '$lib/stores/appVersionCheck.svelte';
import { apiFetch } from '$lib/utils/apiFetch';
import { gatewayUrl } from '$lib/utils/apiUrl';
import { createPausableInterval } from '$lib/utils/backgroundPausableInterval';
import { Log } from '$lib/utils/Log';

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

/**
 * Immediately fetches presence status for all watched users from the gateway and
 * merges the result into `presenceMap`. An asked user ABSENT from the answer is one this account may
 * not see (the gateway shows presence only to people sharing a conversation or a community) and is
 * dropped from the map: unknown, never "offline". Silently skips non-JSON or 401 responses; any
 * other failure (a 503 when the gateway cannot establish the audience) keeps the map as it was.
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

/**
 * The most ids one presence request carries: the gateway's `MAX_PRESENCE_USERS`, the cap of
 * `libs/contracts/presence-audience.cases.json` (`presenceStore.contract.test.ts` pins the two
 * equal). A larger watchlist is split by {@link presenceChunks}, so an honest client never meets the
 * gateway's 400.
 */
export const PRESENCE_IDS_PER_REQUEST = 1000;

/**
 * The watchlist cut into requests of at most {@link PRESENCE_IDS_PER_REQUEST} ids, in watchlist
 * order - THE one place a presence question is split. Deterministic: the same watchlist always gives
 * the same requests, and there is nothing timed about when the next one goes.
 */
export function presenceChunks(ids: readonly string[]): string[][] {
  const chunks: string[][] = [];
  for (let at = 0; at < ids.length; at += PRESENCE_IDS_PER_REQUEST) {
    chunks.push(ids.slice(at, at + PRESENCE_IDS_PER_REQUEST));
  }
  return chunks;
}

/** Whether the legacy route has been announced this session: one line, never one per poll. */
let legacyRouteAnnounced = false;
/** Whether the current wait for `/api/version` has been announced: one line per wait. */
let unknownRouteAnnounced = false;

/**
 * Asks the gateway about `ids` and returns its map, or `null` when it gave no usable answer (each
 * cause logged here, where it is known).
 *
 * THE IDS GO IN A POST BODY, never in the URL (2026-10-28): a query string is written to every
 * proxy's access log, which put the id of everybody a member watches in logs of a host this project
 * does not own, tripped a log scanner with its length, and outgrows a proxy's header buffer for a
 * long watchlist. `legacyGet` is the route of an estate whose gateway predates the POST (its
 * `/api/version` says `presencePost` is not served - a store build reaches phones before production
 * deploys); it goes when every estate serves the POST ([legacy-compatibility](docs/wiki/legacy-compatibility.md)).
 */
async function fetchPresence(
  ids: string[],
  legacyGet: boolean
): Promise<Record<string, boolean> | null> {
  const url = `${gatewayUrl()}/api/presence`;
  const res = legacyGet
    ? await apiFetch(`${url}?users=${ids.join(',')}`)
    : await apiFetch(url, { method: 'POST', body: JSON.stringify({ users: ids }) });
  if (!res.ok) {
    if (res.status !== 401) console.warn(`Presence request failed with status ${res.status}.`);
    return null;
  }
  const contentType = res.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.includes('application/json')) {
    console.warn('Presence endpoint returned non-JSON response, skipping update.');
    return null;
  }
  return (await res.json()) as Record<string, boolean>;
}

async function pollPresence(): Promise<void> {
  const asked = Array.from(peerIdsToPoll);
  const postServed = serverPresencePost();
  if (postServed === null) {
    // Not known is not "no": guessing the legacy route would put the ids back in a URL, and guessing
    // the POST would be answered 405 by an older gateway. The next tick asks again.
    if (!unknownRouteAnnounced) {
      unknownRouteAnnounced = true;
      Log.d(`[presence] ${asked.length} watched user(s) not asked: /api/version has not answered`);
    }
    return;
  }
  unknownRouteAnnounced = false;
  if (!postServed && !legacyRouteAnnounced) {
    legacyRouteAnnounced = true;
    Log.d('[presence] this estate predates POST /api/presence - asking with the legacy GET');
  }
  try {
    const data: Record<string, boolean> = {};
    // ONE request on the legacy route, as before it; up to the cap per request on the POST. Any
    // request that gives no usable answer leaves the whole map as it was.
    for (const ids of postServed ? presenceChunks(asked) : [asked]) {
      const answer = await fetchPresence(ids, !postServed);
      if (answer === null) return;
      Object.assign(data, answer);
    }
    // Only replace the map object when at least one value actually changed,
    // preventing cascading re-renders on every poll when statuses are stable.
    let cameOnline: string[] = [];
    let hidden: string[] = [];
    presenceMap.update((prev) => {
      // An offline -> online EDGE, not the level: a user already known to be online says nothing
      // new, and a user we have never seen before is not "back" either.
      cameOnline = Object.keys(data).filter((k) => data[k] === true && prev[k] === false);
      // An asked id ABSENT from a 200 is one this account may not see (WP-PRESENCE: only people
      // sharing a conversation or a community with them). Its last value is dropped, so a person
      // who stopped sharing anything does not keep a dot frozen at what it last was.
      hidden = asked.filter((k) => !(k in data) && k in prev);
      const hasChange = hidden.length > 0 || Object.keys(data).some((k) => prev[k] !== data[k]);
      if (!hasChange) return prev;
      const next = { ...prev, ...data };
      for (const k of hidden) delete next[k];
      return next;
    });
    if (hidden.length > 0) Log.d(`[presence] ${hidden.length} watched user(s) no longer visible`);
    if (cameOnline.length > 0) notifyCameOnline(cameOnline);
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
  legacyRouteAnnounced = false;
  unknownRouteAnnounced = false;
  presenceMap.set({});
  if (_destroyInterval) {
    _destroyInterval();
    _destroyInterval = null;
  }
}
