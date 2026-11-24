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
      /**
       * The asker holds frames of this group it cannot read and no repair has landed since. A
       * responder that then holds nothing the asker lacks ANSWERS so (`history_cannot_repair`)
       * instead of staying silent. Absent on every ordinary probe and from older builds.
       */
      incomplete?: boolean;
    }
  | {
      kind: 'digest';
      digest: HistoryDigest;
      since: number;
      /** The asker's id for this ask, echoed on the answer (an ask without one is never stored). */
      requestId: string;
      /** The key the ask carried (`parseHistoryAnswerKey`) - the answer is sealed to it. */
      answerKey: string;
      /**
       * The asker is owed the conversation's STATE (`registerOwed.ts`): the responder sends it one
       * sealed register frame before the diff (`sendRegisterAnswer`). Absent from older builds.
       */
      register?: true;
      /**
       * The asker holds frames of this group it cannot read and no repair has landed since. A
       * responder that then holds nothing the asker lacks ANSWERS so (`history_cannot_repair`)
       * instead of staying silent. Absent on every ordinary probe and from older builds.
       */
      incomplete?: boolean;
    }
  | {
      kind: 'range';
      /** The asker holds nothing older than this and wants what precedes it. */
      before: number;
      /** How many messages it is willing to receive in one answer. */
      limit: number;
      since: number;
      /** The asker's id for this ask, echoed on the answer (an ask without one is never stored). */
      requestId: string;
      /** The key the ask carried (`parseHistoryAnswerKey`) - the answer is sealed to it. */
      answerKey: string;
    };

type StoredProbe = { probe: SolicitedProbe; at: number };

/**
 * Probes nobody was waiting for, per group and asker, OLDEST FIRST - a queue, the same FIFO as the
 * waiters: two probes that land before any election registers are two asks, and one slot per key
 * dropped the first of them.
 */
const probes = new Map<string, StoredProbe[]>();
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
  for (const [k, queue] of probes) {
    const fresh = queue.filter((entry) => now - entry.at < DIGEST_TTL_MS);
    if (fresh.length === 0) probes.delete(k);
    else if (fresh.length !== queue.length) probes.set(k, fresh);
  }
}

/**
 * Removes and returns the oldest stored probe of `k` that arrived at or after `notBefore`, or
 * `undefined` when none did.
 */
function takeStored(k: string, notBefore: number): SolicitedProbe | undefined {
  const queue = probes.get(k);
  if (!queue) return undefined;
  const at = queue.findIndex((entry) => entry.at >= notBefore);
  if (at === -1) return undefined;
  const [taken] = queue.splice(at, 1);
  if (queue.length === 0) probes.delete(k);
  return taken.probe;
}

/**
 * Where {@link noteProbeReceived} put a probe: a waiting election took it (`waiter`), it is the late
 * digest of an exchange WE opened and the caller answers it now (`solicitation`), or nobody claimed
 * it and it is kept for an election still to come (`stored`).
 */
export type ProbeDestination = 'waiter' | 'solicitation' | 'stored';

/**
 * Records a probe that arrived over MLS, waking a request already waiting for one.
 *
 * The waiter is resolved and dropped rather than left to poll: the request half is on a deadline,
 * and a probe that lands one millisecond inside it must be used, not missed.
 *
 * **ONE PROBE WAKES ONE WAITER - the oldest - and the others keep waiting.** A probe is one ask, and
 * since answers are addressed (history-answer-addressing.md) it carries one `requestId` that the
 * asker closes per answering device on that device's `last` chunk. Handing it to every waiter made a
 * device elected twice for the same asker answer the SAME ask twice, chunk for chunk; the asker
 * ingested the first copy and refused the second at error (`[HISTORY_ADDRESSED] REFUSED ... its
 * answerers are all taken`), measured on a new web device on 2026-11-24 in four conversations. A
 * second election comes with its own probe, which wakes the next waiter; a waiter whose probe never
 * comes ends as before, on its deadline.
 *
 * **Returns where it went ({@link ProbeDestination})**, the caller's only way to tell a probe that
 * answered a wait from one that arrived after the wait ended. A digest nobody waits for is the late
 * half of an exchange we opened when a solicitation is outstanding (`takeDigestSolicitation`): it is
 * then CLAIMED HERE, in the same step, and never stored. Stored, a re-election of this device for
 * the same asker (a reconcile after the coalescing window, a scrollback) consumed it again from
 * `awaitProbe` and answered the same `requestId` a second time - the sibling of the double answer
 * above, and the asker refuses that copy the same way.
 */
export function noteProbeReceived(
  groupId: string,
  fromIdentity: string,
  probe: SolicitedProbe,
  now: number = Date.now()
): ProbeDestination {
  const k = key(groupId, fromIdentity);
  purgeExpired(now);

  const pending = waiters.get(k);
  if (pending && pending.length > 0) {
    const [oldest, ...rest] = pending;
    if (rest.length > 0) waiters.set(k, rest);
    else waiters.delete(k);
    oldest(probe);
    return 'waiter';
  }
  if (probe.kind === 'digest' && takeDigestSolicitation(groupId, fromIdentity, now)) {
    return 'solicitation';
  }
  probes.set(k, [...(probes.get(k) ?? []), { probe, at: now }]);
  return 'stored';
}

/**
 * Waits up to `timeoutMs` for `fromIdentity`'s next probe for this group, resolving `null` when none
 * arrives.
 *
 * A probe already in hand is CONSUMED, not reused: it answers this request and no later one, so a
 * second solicitation always compares against a fresh snapshot rather than a stale claim. That is
 * also what lets one exchange await twice - a `state` first, then the `digest` it asked for.
 *
 * **`notBefore` is what makes that true from three online devices upward.** Every member stores
 * every probe - the frame is a group broadcast and knows nothing about the election that picked a
 * responder - and probes live for `DIGEST_TTL_MS` (60 s) while the asker re-probes after
 * `PROBE_COALESCE_MS` (30 s). So a member elected for the SECOND ask could be holding the FIRST
 * ask's probe and answer with it, comparing against a state key up to a minute old.
 *
 * **It is written as a PREFERENCE, and in production it acts as a rejection.** A probe older than
 * `notBefore` is set aside rather than consumed, and the caller waits for the one that should be on
 * its way; at the deadline the set-aside probe is used only if it has not expired. The one
 * production caller (`handleHistoryRequest`) waits `HISTORY_PROBE_WAIT_MS`, which IS `DIGEST_TTL_MS`,
 * and a probe set aside was stored before the wait began - so by the deadline it has always expired,
 * and the fallback never fires there: a stale probe is never answered, and an election whose own
 * probe never comes answers nothing. A shorter wait (the tests) does reach the fallback.
 *
 * That matters because the ordering this rests on - the asker sends its election before its probe,
 * and the server publishes the election before answering - is a property of two independent
 * transports, and this module has always been written on the basis that neither sequences the other.
 * Making it a hard rejection would turn any violation into a silent lost repair.
 */
export function awaitProbe(
  groupId: string,
  fromIdentity: string,
  timeoutMs: number,
  notBefore: number = 0,
  now: number = Date.now()
): Promise<SolicitedProbe | null> {
  const k = key(groupId, fromIdentity);
  purgeExpired(now);

  const stored = takeStored(k, notBefore);
  if (stored) return Promise.resolve(stored);

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
      // NOTHING FRESH CAME, so fall back to the probe we set aside rather than answering nothing.
      // This is what keeps `notBefore` a PREFERENCE and not a gamble: if the ordering assumption it
      // rests on is ever wrong, the exchange still happens with the older snapshot - exactly what it
      // did before - instead of the responder going silent and the repair being lost.
      //
      // Purged first: the wait itself can outlive the probe's TTL, and falling back to one that has
      // expired would be the very staleness `notBefore` exists to bound.
      purgeExpired(Date.now());
      const setAside = takeStored(k, 0);
      if (setAside) {
        finish(setAside);
        return;
      }
      finish(null);
    }, timeoutMs);

    const onProbe = (probe: SolicitedProbe): void => finish(probe);
    waiters.set(k, [...(waiters.get(k) ?? []), onProbe]);
  });
}

/**
 * How long a solicitation WE issued stays answerable, and it bounds MEMORY rather than correctness.
 *
 * The distinction is the whole point of this map. `DIGEST_TTL_MS` bounds how old a PROBE may be
 * when it is used, because a probe describes a store at a moment and the store moves. Nothing about
 * an answer decays that way: the digest that arrives carries its own manifest and its own window,
 * and our store answers it as it stands when it is read. So a digest arriving late is a complete
 * question, and the only reason to forget we asked is that this map cannot grow for ever.
 *
 * **It was measured at ten minutes of slack against a sixty-second wait.** On 2026-09-05 a device
 * that had just rejoined an account with twenty groups took 67 s to drain its queue and answered
 * seven seconds after `handleHistoryRequest` gave up; the digest was recorded, nobody was waiting
 * for it, and three messages were lost permanently. A device draining a queue is slow in
 * proportion to what it has to apply, which is why the slack is an order of magnitude and not a
 * margin.
 */
const SOLICITATION_TTL_MS = 10 * 60_000;

/** Groups we asked a device to describe itself for, and when we asked. */
const solicited = new Map<string, number>();

/**
 * Records that we asked `identity` to describe its store for this group.
 *
 * Idempotent by construction: a second ask replaces the first, because it is the same question and
 * the newer instant is the one a late digest should be measured against.
 */
export function noteDigestSolicited(
  groupId: string,
  identity: string,
  now: number = Date.now()
): void {
  for (const [k, at] of solicited) if (now - at >= SOLICITATION_TTL_MS) solicited.delete(k);
  solicited.set(key(groupId, identity), now);
}

/**
 * Consumes the solicitation for this group and device, answering whether one was outstanding.
 *
 * CONSUMED, not read: one ask is answered once. A second digest from the same device for the same
 * group is a new exchange and needs a new ask, which is what keeps an unsolicited digest - the same
 * frame reaching every member of the group, since this leg is a broadcast - from making every one of
 * them answer at once. The election exists to pick a single responder and this preserves it.
 */
export function takeDigestSolicitation(
  groupId: string,
  identity: string,
  now: number = Date.now()
): boolean {
  const k = key(groupId, identity);
  const at = solicited.get(k);
  if (at === undefined) return false;
  solicited.delete(k);
  return now - at < SOLICITATION_TTL_MS;
}

/** Forgets everything held for a group (leaving it, or logging out). */
export function forgetGroupDigests(groupId: string): void {
  const prefix = `${groupId}|`;
  for (const k of probes.keys()) if (k.startsWith(prefix)) probes.delete(k);
  for (const k of waiters.keys()) if (k.startsWith(prefix)) waiters.delete(k);
  for (const k of solicited.keys()) if (k.startsWith(prefix)) solicited.delete(k);
}

/** @internal Resets module state between Vitest cases. */
export function resetHistoryDigestRendezvousForTests(): void {
  probes.clear();
  waiters.clear();
  solicited.clear();
}
