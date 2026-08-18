import { GraineInputError, newGraineSeed, newGraineSessionId } from '$lib/crypto/graine';
import { GRAINE_ROTATE_AFTER_MESSAGES, GRAINE_ROTATE_AFTER_MS } from '$lib/crypto/graineConstants';
import type { IStorage, StoredGraineSession } from '$lib/db/types';
import { toBase64 } from '$lib/utils/hex';

/**
 * The OUTBOUND half of Graine: which session this device seals its next channel message under.
 *
 * One question, answered in one place: reuse the session already in hand, or mint a new one. Every
 * caller that answered it for itself would be a caller free to answer it differently, and the two
 * answers differ by exactly how long a departed member keeps reading.
 *
 * Protocol, thresholds and the alternatives ruled out:
 * `docs/wiki/protocols/channel-encryption.md`.
 */

/** The (community, channel, sender) a session belongs to. */
export interface GraineOutboundScope {
  workspaceId: string;
  channelId: string;
  /** This device's own user id. Normalised here, see {@link reserveOutboundSlot}. */
  senderId: string;
}

/** Everything the manager needs from the outside, so it owns no singleton and reads no clock of its own. */
export interface GraineOutboundDeps {
  storage: IStorage;
  deviceKeyB64: string;
  /**
   * Current MLS epoch of the community's distribution group.
   *
   * Required, and required to be a real epoch: a session minted without one could never be judged
   * against a later roster, so it would seal messages for a member who has left with nothing ever
   * noticing. A caller that has not joined the group yet must fail rather than pass a placeholder.
   */
  distributionEpoch: number;
  /**
   * Hands a freshly minted session to the community over the distribution group.
   *
   * MUST throw when the seed did not go out. It is awaited BEFORE the session is persisted, so a
   * failure leaves nothing behind: see {@link reserveOutboundSlot}.
   */
  distribute: (session: StoredGraineSession) => Promise<void>;
  /** Injectable clock, for tests. Never used to decide anything but the age threshold. */
  now?: () => number;
}

/** A reserved place in a session: the session to seal with, and the index to seal at. */
export interface GraineOutboundSlot {
  session: StoredGraineSession;
  /** Already reserved and persisted - this index is handed out exactly once. */
  index: number;
  /** True when this call minted the session, and therefore when a seed has just been distributed. */
  minted: boolean;
}

/**
 * Why the session in hand may not seal another message, or null when it may.
 *
 * Pure, exported and named rather than inlined as a boolean: the four causes have four very
 * different meanings, and the one that matters - a roster that changed - is invisible in a
 * "should I rotate" that only answers yes.
 */
export type GraineRotationReason = 'no-session' | 'message-count' | 'age' | 'roster';

/**
 * Decides rotation from the session alone, given the group's current epoch and the time.
 *
 * **`roster` is the structural one and the reason the epoch is stored at all.** Every membership
 * change commits to the community's distribution group and advances its epoch, so an epoch that no
 * longer matches means the set of people holding this seed is no longer the set of people entitled
 * to it. Compared with `!==` rather than `<`: any disagreement is a disagreement, and the safe
 * response to one we cannot explain is still to rotate.
 *
 * A session predating the column carries no epoch and is rotated for the same reason - "minted
 * under a roster nobody recorded" is not evidence of a roster that still holds.
 *
 * An ADD advances the epoch too, and rotates a session it did not have to. That is deliberate: the
 * cost is one extra O(1) seed distribution, and the alternative - a durable "somebody LEFT" marker -
 * is state that has to be written by every device, kept until every session has cycled past it, and
 * is silently wrong the once it is missed.
 */
export function graineRotationReason(
  session: StoredGraineSession | null,
  at: { distributionEpoch: number; now: number }
): GraineRotationReason | null {
  if (!session) return 'no-session';
  if (session.distributionEpoch !== at.distributionEpoch) return 'roster';
  if ((session.sentCount ?? 0) >= GRAINE_ROTATE_AFTER_MESSAGES) return 'message-count';
  if (at.now - session.createdAt >= GRAINE_ROTATE_AFTER_MS) return 'age';
  return null;
}

/**
 * Reserves the next outbound slot for `scope`, minting and distributing a session when needed.
 *
 * **Serialised per (channel, sender).** The index is `firstIndex + sentCount`, so two sends racing
 * on one channel would read the same count and seal two different messages under the same key -
 * the one catastrophic failure of AES-GCM, and one that leaves no trace at either end. The chain
 * below makes that unrepresentable rather than unlikely.
 *
 * **The index is burned before the message is sent, and stays burned if the send fails.** A gap in
 * the indices costs nothing: every message carries its own index and the receiver derives that key
 * directly. Re-handing an index out, on a send that failed after the server had it, costs the whole
 * session.
 *
 * **A minted session is distributed BEFORE it is persisted, and never the other way round.** If
 * distribution fails after persisting, the session is in hand and will be reused, so every message
 * sealed under it is unreadable by everyone including its own author, permanently. Distributing
 * first means a failure leaves the seed nowhere: the send fails, and the next attempt mints again.
 *
 * @throws {GraineInputError} when the distribution epoch is not a real epoch - a caller that has not
 *   joined the group must not seal anything.
 */
export async function reserveOutboundSlot(
  deps: GraineOutboundDeps,
  scope: GraineOutboundScope
): Promise<GraineOutboundSlot> {
  // `async`, so this refusal arrives as a rejection like every other failure here. A validation
  // thrown synchronously out of a promise-returning function is the one a `.catch()` walks past.
  if (!Number.isInteger(deps.distributionEpoch) || deps.distributionEpoch < 0) {
    throw new GraineInputError(
      `Distribution-group epoch must be a non-negative integer, got ${deps.distributionEpoch}. ` +
        `A session minted without one can never be checked against a later roster.`
    );
  }
  // Lower-cased at the ONE place a session is looked up and the one place it is written. A row
  // stored under `Alice` and searched for as `alice` is never found, so every send mints, and the
  // symptom is a community that works perfectly while rotating on every message.
  const senderId = scope.senderId.toLowerCase();
  return serialize(`${scope.channelId}|${senderId}`, () => reserve(deps, { ...scope, senderId }));
}

/** The body of {@link reserveOutboundSlot}, already inside the per-channel chain. */
async function reserve(
  deps: GraineOutboundDeps,
  scope: GraineOutboundScope
): Promise<GraineOutboundSlot> {
  const now = deps.now?.() ?? Date.now();
  const sessions = await deps.storage.getGraineSessions(scope.channelId, deps.deviceKeyB64);
  // `getGraineSessions` answers newest first, so the first candidate IS the current one. Two
  // filters, and the second is not redundant with the first:
  //  - another SENDER's session is held to READ; sealing with it would write into somebody else's
  //    namespace;
  //  - a session of this same user MINTED ON ANOTHER DEVICE arrives here through the distribution
  //    group and carries no `sentCount`, which is exactly what says "not minted here". Continuing
  //    its indices from a count this device never kept is two messages under one key.
  const current =
    sessions.find((s) => s.senderId === scope.senderId && s.sentCount !== undefined) ?? null;
  const reason = graineRotationReason(current, { distributionEpoch: deps.distributionEpoch, now });

  if (!reason && current) {
    const index = current.firstIndex + (current.sentCount ?? 0);
    const updated: StoredGraineSession = { ...current, sentCount: (current.sentCount ?? 0) + 1 };
    await deps.storage.saveGraineSession(updated, deps.deviceKeyB64);
    return { session: updated, index, minted: false };
  }

  const minted: StoredGraineSession = {
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    senderId: scope.senderId,
    sessionId: newGraineSessionId(),
    seedB64: toBase64(newGraineSeed()),
    // A session this device minted starts at zero by construction: nobody handed it over mid-way.
    firstIndex: 0,
    createdAt: now,
    sentCount: 0,
    distributionEpoch: deps.distributionEpoch,
  };
  await deps.distribute(minted);
  const stored: StoredGraineSession = { ...minted, sentCount: 1 };
  await deps.storage.saveGraineSession(stored, deps.deviceKeyB64);
  // Rare by design - once per 100 messages, per week, or per membership change - and the only
  // record that a departure took a seed out of circulation. A rate that climbs means the epoch is
  // moving for a reason nobody has looked at yet.
  console.info(
    `[GRAINE] new outbound session ${minted.sessionId} for channel ${scope.channelId.slice(0, 8)} ` +
      `at distribution epoch ${deps.distributionEpoch} (${reason})`
  );
  return { session: stored, index: 0, minted: true };
}

/**
 * One promise chain per key, so the read-decide-write above can never interleave with itself.
 *
 * Chained on settle rather than on success: a reservation that threw must not stall every send that
 * follows it on that channel.
 */
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  chains.set(key, next);
  void next
    .catch(() => undefined)
    .then(() => {
      // Only the tail may clear the entry: a slower predecessor deleting it would let the next
      // caller start a second chain beside the one still running.
      if (chains.get(key) === next) chains.delete(key);
    });
  return next;
}
