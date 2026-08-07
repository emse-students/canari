import type { HistoryDigest } from './historyManifest';

/**
 * The meeting point between the two halves of a history solicitation, which travel by different
 * transports and can arrive in either order.
 *
 * A requester does two things: it asks the SERVER to elect one member to answer (the WebSocket
 * `history_request`, which is what keeps a single responder instead of every co-member replying at
 * once), and it broadcasts what it already HOLDS inside MLS (`history_digest`, which the server must
 * not be able to read). Nothing orders those two against each other: the elected responder can be
 * handed the request before the digest reaches its inbound queue, or after.
 *
 * So the responder does not decide on arrival - it waits, briefly, for the other half. If the digest
 * comes, it answers with a difference; if it does not, it falls back to the whole store, which is
 * exactly what a client too old to send a digest expects. That fallback is not a safety net, it is
 * the compatibility story: this is how the diff rolls out to a fleet where the phone is several
 * versions behind the web.
 *
 * In memory and short-lived by design. A digest is a snapshot of a moment; answering a request from
 * a minute-old one would diff against a store that has moved.
 */

/** How long a digest stays usable after arriving. Beyond this it describes a store that has moved. */
const DIGEST_TTL_MS = 60_000;

type StoredDigest = { digest: HistoryDigest; at: number };

const digests = new Map<string, StoredDigest>();
const waiters = new Map<string, Array<(digest: HistoryDigest) => void>>();

/**
 * Identifies the DEVICE, not the user: a user with three devices must be able to solicit from one
 * of them without the other two answering a pull addressed to their owner.
 */
export function digestIdentity(userId: string, deviceId: string): string {
  return `${userId.toLowerCase()}:${deviceId}`;
}

function key(groupId: string, identity: string): string {
  return `${groupId}|${identity.toLowerCase()}`;
}

/** Drops digests that have aged out, so a stale one can never be handed to a waiting request. */
function purgeExpired(now: number): void {
  for (const [k, entry] of digests) {
    if (now - entry.at >= DIGEST_TTL_MS) digests.delete(k);
  }
}

/**
 * Records a digest that arrived over MLS, waking a request already waiting for it.
 *
 * The waiter is resolved and dropped rather than left to poll: the request half is on a deadline,
 * and a digest that lands one millisecond inside it must be used, not missed.
 */
export function noteDigestReceived(
  groupId: string,
  fromIdentity: string,
  digest: HistoryDigest,
  now: number = Date.now()
): void {
  const k = key(groupId, fromIdentity);
  purgeExpired(now);

  const pending = waiters.get(k);
  if (pending && pending.length > 0) {
    waiters.delete(k);
    for (const resolve of pending) resolve(digest);
    return;
  }
  digests.set(k, { digest, at: now });
}

/**
 * Waits up to `timeoutMs` for `fromIdentity`'s digest for this group, resolving `null` when none
 * arrives - the caller must then fall back to sending its whole store.
 *
 * A digest already in hand is CONSUMED, not reused: it answers this request and no later one, so a
 * second solicitation always diffs against a fresh snapshot rather than a stale claim.
 */
export function awaitDigest(
  groupId: string,
  fromIdentity: string,
  timeoutMs: number,
  now: number = Date.now()
): Promise<HistoryDigest | null> {
  const k = key(groupId, fromIdentity);
  purgeExpired(now);

  const stored = digests.get(k);
  if (stored) {
    digests.delete(k);
    return Promise.resolve(stored.digest);
  }

  return new Promise<HistoryDigest | null>((resolve) => {
    let settled = false;
    const finish = (digest: HistoryDigest | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(digest);
    };

    const timer = setTimeout(() => {
      // Drop only OUR waiter: a second request for the same peer may still be legitimately waiting.
      const list = waiters.get(k);
      if (list) {
        const next = list.filter((fn) => fn !== onDigest);
        if (next.length > 0) waiters.set(k, next);
        else waiters.delete(k);
      }
      finish(null);
    }, timeoutMs);

    const onDigest = (digest: HistoryDigest): void => finish(digest);
    waiters.set(k, [...(waiters.get(k) ?? []), onDigest]);
  });
}

/** Forgets everything held for a group (leaving it, or logging out). */
export function forgetGroupDigests(groupId: string): void {
  const prefix = `${groupId}|`;
  for (const k of digests.keys()) if (k.startsWith(prefix)) digests.delete(k);
  for (const k of waiters.keys()) if (k.startsWith(prefix)) waiters.delete(k);
}

/** @internal Resets module state between Vitest cases. */
export function resetHistoryDigestRendezvousForTests(): void {
  digests.clear();
  waiters.clear();
}
