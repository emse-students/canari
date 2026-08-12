import type { HistoryDigest } from './historyManifest';

/**
 * The meeting point between the two halves of a history solicitation, which travel by different
 * transports and can arrive in either order.
 *
 * A requester does two things: it asks the SERVER to elect one member to answer (the WebSocket
 * `history_request`, which is what keeps a single responder instead of every co-member replying at
 * once), and it states what it wants INSIDE MLS, which the server must not be able to read. Nothing
 * orders those two against each other: the elected responder can be handed the election before the
 * probe reaches its inbound queue, or after. So the responder does not decide on arrival - it waits,
 * briefly, for the other half.
 *
 * **A probe, not a digest.** The MLS half used to be a digest and nothing else. It is now one of
 * three asks, and the responder branches on which arrived:
 *
 * - `state` - a 64-bit key standing for everything the asker holds in its window. The common ask, and
 *   the common answer is "we agree", which costs one frame and no store read on either side;
 * - `digest` - the hierarchical manifest, sent only after a `state` comparison came out different.
 *   It is a second probe on the same rendezvous rather than a channel of its own, because it is the
 *   second leg of the SAME solicitation;
 * - `range` - scrollback: a bounded window below what the asker holds, triggered by a reader
 *   scrolling rather than by a connection.
 *
 * In memory and short-lived by design. A probe is a snapshot of a moment; answering a request from a
 * minute-old one would compare against a store that has moved.
 */

/** How long a probe stays usable after arriving. Beyond this it describes a store that has moved. */
export const DIGEST_TTL_MS = 60_000;

/**
 * A solicitation as the responder receives it: what the asker WANTS, and where its window OPENS.
 *
 * `since` is on every variant because every one of them is an ASK, and an ask that does not state
 * its window can only be answered in full - the behaviour the window exists to end. It is stated by
 * the asker and never recomputed here: the window slides, so two devices deriving it a second apart
 * disagree by whatever was sent in between.
 */
export type SolicitedProbe =
  | {
      kind: 'state';
      /** What the asker holds in `[since, now]`, folded to 64 bits. See `historyStateKey`. */
      key: string;
      since: number;
    }
  | { kind: 'digest'; digest: HistoryDigest; since: number }
  | {
      kind: 'range';
      /** The asker holds nothing older than this and wants what precedes it. */
      before: number;
      /** How many messages it is willing to receive in one answer. */
      limit: number;
      since: number;
    };

type StoredProbe = { probe: SolicitedProbe; at: number };

const probes = new Map<string, StoredProbe>();
const waiters = new Map<string, Array<(probe: SolicitedProbe) => void>>();

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

/** Drops probes that have aged out, so a stale one can never be handed to a waiting request. */
function purgeExpired(now: number): void {
  for (const [k, entry] of probes) {
    if (now - entry.at >= DIGEST_TTL_MS) probes.delete(k);
  }
}

/**
 * Records a probe that arrived over MLS, waking a request already waiting for one.
 *
 * The waiter is resolved and dropped rather than left to poll: the request half is on a deadline,
 * and a probe that lands one millisecond inside it must be used, not missed.
 */
export function noteProbeReceived(
  groupId: string,
  fromIdentity: string,
  probe: SolicitedProbe,
  now: number = Date.now()
): void {
  const k = key(groupId, fromIdentity);
  purgeExpired(now);

  const pending = waiters.get(k);
  if (pending && pending.length > 0) {
    waiters.delete(k);
    for (const resolve of pending) resolve(probe);
    return;
  }
  probes.set(k, { probe, at: now });
}

/**
 * Waits up to `timeoutMs` for `fromIdentity`'s next probe for this group, resolving `null` when none
 * arrives.
 *
 * A probe already in hand is CONSUMED, not reused: it answers this request and no later one, so a
 * second solicitation always compares against a fresh snapshot rather than a stale claim. That is
 * also what lets one exchange await twice - a `state` first, then the `digest` it asked for.
 */
export function awaitProbe(
  groupId: string,
  fromIdentity: string,
  timeoutMs: number,
  now: number = Date.now()
): Promise<SolicitedProbe | null> {
  const k = key(groupId, fromIdentity);
  purgeExpired(now);

  const stored = probes.get(k);
  if (stored) {
    probes.delete(k);
    return Promise.resolve(stored.probe);
  }

  return new Promise<SolicitedProbe | null>((resolve) => {
    let settled = false;
    const finish = (probe: SolicitedProbe | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };

    const timer = setTimeout(() => {
      // Drop only OUR waiter: a second request for the same peer may still be legitimately waiting.
      const list = waiters.get(k);
      if (list) {
        const next = list.filter((fn) => fn !== onProbe);
        if (next.length > 0) waiters.set(k, next);
        else waiters.delete(k);
      }
      finish(null);
    }, timeoutMs);

    const onProbe = (probe: SolicitedProbe): void => finish(probe);
    waiters.set(k, [...(waiters.get(k) ?? []), onProbe]);
  });
}

/** Forgets everything held for a group (leaving it, or logging out). */
export function forgetGroupDigests(groupId: string): void {
  const prefix = `${groupId}|`;
  for (const k of probes.keys()) if (k.startsWith(prefix)) probes.delete(k);
  for (const k of waiters.keys()) if (k.startsWith(prefix)) waiters.delete(k);
}

/** @internal Resets module state between Vitest cases. */
export function resetHistoryDigestRendezvousForTests(): void {
  probes.clear();
  waiters.clear();
}
