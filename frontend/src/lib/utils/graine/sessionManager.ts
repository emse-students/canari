import { GraineInputError, newGraineSeed, newGraineSessionId } from '$lib/crypto/graine';
import {
  GRAINE_REUSED_ROTATE_AFTER_MESSAGES,
  GRAINE_REUSED_ROTATE_AFTER_MS,
  GRAINE_ROTATE_AFTER_MESSAGES,
  GRAINE_ROTATE_AFTER_MS,
} from '$lib/crypto/graineConstants';
import type { GraineRunReading } from '$lib/mls-client/IMlsService';
import type {
  GraineDistributionFrame,
  IStorage,
  StoredGraineSession,
  StoredGraineV2,
} from '$lib/db/types';
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
   * The key group's departure tracker at its current epoch (`IMlsService.graineRun`). Read inside
   * the per-channel chain, from the same MLS instance whose next send seals the distribution frame.
   */
  readRun: () => Promise<GraineRunReading>;
  /**
   * Hands a freshly minted session to the community over the distribution group.
   *
   * MUST throw when the seed did not go out. It is awaited BEFORE the session is persisted, so a
   * failure leaves nothing behind: see {@link reserveOutboundSlot}. Answers the frame it posted,
   * which the session keeps so every message sealed under it can carry it.
   */
  distribute: (session: StoredGraineSession) => Promise<GraineDistributionFrame>;
  /**
   * Makes a freshly minted session a Graine v2 one: its key pair and this device's endorsement
   * (`endorseNewSession`). Awaited BEFORE the seed is distributed, since the endorsement travels
   * with it - a v2 seed handed over without one is refused by every reader.
   */
  endorse: (session: StoredGraineSession) => Promise<StoredGraineV2>;
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
  /** True when this call sent the session's existing seed again at a new epoch. */
  redistributed: boolean;
}

/**
 * What to do with the session in hand before sealing the next message:
 *
 * - `reuse` - seal under it as it is;
 * - `redistribute` - the key group's epoch moved and nobody left: seal under it, after sending its
 *   SAME seed again at the current epoch, so a device added since can open it;
 * - `rotate` - mint a new session.
 */
export type GraineOutboundVerdict = 'reuse' | 'redistribute' | 'rotate';

/**
 * The one decision of the outbound half, pure and exported so no caller answers it differently -
 * two answers would differ by exactly how long a departed member keeps reading.
 *
 * **Rotate on a departure, not on every epoch** (`docs/wiki/protocols/graine-removal-tracker.md`).
 * Until 2026-10-22 any epoch change rotated, and every device joining the key group commits, so
 * production minted one session per two messages (2026-10-21). The epoch move is now judged by the
 * key group's departure tracker, read from the MLS state (`run`):
 *
 * - **Same epoch as the last distribution** (the fingerprint, never the number - a re-bootstrapped
 *   group reaches the same number with other secrets): `reuse`.
 * - **Same clean run as the mint**: every commit since was merged here, none removed a leaf and
 *   none brought a new user, so whoever holds the seed is still a member: `redistribute`.
 * - **Anything else** - a removal (an external rejoin's removal of its own old leaf included), a new
 *   user, a gap the tracker did not see, a session minted before the tracker: `rotate`.
 *
 * And the unconditional causes, unchanged: no distribution frame to carry (channel-encryption
 * section 19), no v2 secret to sign with (WP-G2-5), and the caps - 100 messages or 7 days, or 50 and
 * 24 hours once the session has been re-distributed (the named residual of the design page).
 *
 * The history setting is deliberately NOT an input: the new-user rule keeps a newcomer from a seed
 * minted before it arrived under either setting, and the setting is the server's word.
 */
export function graineOutboundVerdict(
  session: StoredGraineSession | null,
  at: { run: GraineRunReading; now: number }
): GraineOutboundVerdict {
  if (!session) return 'rotate';
  const anchor = session.rotationAnchor;
  const capMessages = anchor?.redistributed
    ? GRAINE_REUSED_ROTATE_AFTER_MESSAGES
    : GRAINE_ROTATE_AFTER_MESSAGES;
  const capMs = anchor?.redistributed ? GRAINE_REUSED_ROTATE_AFTER_MS : GRAINE_ROTATE_AFTER_MS;
  if (
    !anchor ||
    !session.distributionFrame ||
    // EVERY SESSION THIS DEVICE SEALS UNDER IS V2 (WP-G2-5), so a v1 one rotates, once, and so
    // does a v2 one whose secret is not here to sign with - a session restored from a backup.
    !session.v2?.signingSecretKeyB64 ||
    (session.sentCount ?? 0) >= capMessages ||
    at.now - session.createdAt >= capMs
  ) {
    return 'rotate';
  }
  if (anchor.epochFingerprint === at.run.epochFingerprint) return 'reuse';
  if (anchor.runId !== at.run.runId) return 'rotate';
  // A re-distribution makes it a REUSED session, whose tighter caps must already hold: one that
  // would be past them the moment it was re-distributed rotates instead.
  const reusedCapsHit =
    (session.sentCount ?? 0) >= GRAINE_REUSED_ROTATE_AFTER_MESSAGES ||
    at.now - session.createdAt >= GRAINE_REUSED_ROTATE_AFTER_MS;
  return reusedCapsHit ? 'rotate' : 'redistribute';
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
  // Read BEFORE anything is sealed: a commit landing between this read and the seal can only make
  // the anchor older than the frame, which the next send reads as a move and judges again.
  const run = await deps.readRun();
  const verdict = graineOutboundVerdict(current, { run, now });

  if (verdict === 'reuse' && current) {
    const index = current.firstIndex + (current.sentCount ?? 0);
    const updated: StoredGraineSession = { ...current, sentCount: (current.sentCount ?? 0) + 1 };
    await deps.storage.saveGraineSession(updated, deps.deviceKeyB64);
    return { session: updated, index, minted: false, redistributed: false };
  }

  if (verdict === 'redistribute' && current?.rotationAnchor) {
    // The SAME seed, the same id, floor and endorsement - only the frame is new, sealed at the
    // current epoch so a device added since can open it. Distributed BEFORE it is persisted, for
    // the reason the mint below gives: a failure leaves the stored session as it was.
    const distributionFrame = await deps.distribute(current);
    const index = current.firstIndex + (current.sentCount ?? 0);
    const updated: StoredGraineSession = {
      ...current,
      sentCount: (current.sentCount ?? 0) + 1,
      distributionEpoch: run.epoch,
      distributionFrame,
      rotationAnchor: {
        ...current.rotationAnchor,
        epochFingerprint: run.epochFingerprint,
        redistributed: true,
      },
    };
    await deps.storage.saveGraineSession(updated, deps.deviceKeyB64);
    console.info(
      `[GRAINE] reused session ${current.sessionId} for channel ${scope.channelId.slice(0, 8)} ` +
        `across epoch ${current.distributionEpoch}->${run.epoch} run ${run.runId.slice(0, 8)}, ` +
        `re-distributed (${updated.sentCount} sent)`
    );
    return { session: updated, index, minted: false, redistributed: true };
  }

  const draft: StoredGraineSession = {
    workspaceId: scope.workspaceId,
    channelId: scope.channelId,
    senderId: scope.senderId,
    sessionId: newGraineSessionId(),
    seedB64: toBase64(newGraineSeed()),
    // A session this device minted starts at zero by construction: nobody handed it over mid-way.
    firstIndex: 0,
    createdAt: now,
    sentCount: 0,
    distributionEpoch: run.epoch,
    rotationAnchor: {
      runId: run.runId,
      epochFingerprint: run.epochFingerprint,
      redistributed: false,
    },
  };
  // Endorsed, then distributed, then persisted: each step needs the one before it, and a failure
  // at any of them leaves nothing behind for the reason the distribution comment above gives.
  const minted: StoredGraineSession = { ...draft, v2: await deps.endorse(draft) };
  const distributionFrame = await deps.distribute(minted);
  const stored: StoredGraineSession = { ...minted, sentCount: 1, distributionFrame };
  await deps.storage.saveGraineSession(stored, deps.deviceKeyB64);
  // Meant to be rare since 2026-10-22: once per removal or new user in the key group, or per cap.
  // The run id is printed so a reading can tell a reset (`[GRAINE] run reset reason=...`, from the
  // MLS layer) apart from a cap: a new session under the SAME run as the previous one was a cap.
  console.info(
    `[GRAINE] new outbound session ${minted.sessionId} for channel ${scope.channelId.slice(0, 8)} ` +
      `at distribution epoch ${run.epoch} run ${run.runId.slice(0, 8)}` +
      `${current ? ` replacing ${current.sessionId}` : ''}, ` +
      `frame ${distributionFrame.protoB64.length} chars`
  );
  return { session: stored, index: 0, minted: true, redistributed: false };
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
