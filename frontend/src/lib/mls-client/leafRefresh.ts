/**
 * THE PERIODIC LEAF REFRESH: WHEN THIS DEVICE REPLACES ITS OWN LEAF IN A CONVERSATION.
 *
 * MLS heals a compromised device only when its leaf is replaced, and until 2026-10-22 nothing here
 * ever replaced one: a device kept the key material it was admitted with for as long as it stayed
 * in the group. A refresh is an empty commit WITH a path (`MlsManager::stage_self_update`), staged
 * and submitted like every other commit (`BaseMlsService.runCommitTransaction`).
 *
 * **TRIGGERED BY ACTIVITY AND DURABLE STATE, NEVER BY A TIMER.** The trigger is this device sending
 * a durable frame in the group (a message, a reaction, an edit, a read receipt) - the device is
 * online, holds a current tree, and the server has just accepted a frame from it. The decision is
 * then read from durable facts: how old THIS leaf is. A device that sends nothing commits nothing,
 * and a device that sends a hundred messages commits at most once per {@link LEAF_REFRESH_INTERVAL_MS}.
 * No jitter and no clock-driven loop: two runs over the same state decide the same thing.
 *
 * **THE AGE OF THE LEAF, AND WHERE EACH HALF OF IT LIVES.**
 * - A leaf ADMITTED from a KeyPackage is dated by the TREE (`own_leaf_minted_at`: the package's
 *   `not_before`), so that date cannot be lost with any bookkeeping of ours.
 * - A leaf produced by a commit carries no date, and EVERY commit this device makes produces one
 *   (openmls puts a path in every member commit it builds - pinned by `mls-core/tests/self_update.rs`).
 *   So {@link noteOwnLeafRefreshed} is written by the one seam every own commit passes through,
 *   after the server accepted it - a refresh, a Remove and an Add alike - and by the external join.
 * - A ledger entry can only describe a commit-sourced leaf, so for a KeyPackage-dated leaf it is
 *   ignored: such a leaf is a newer incarnation (a Welcome after the group was forgotten).
 *
 * **WHERE IT MUST NOT RUN.** A community's key group: there, any epoch move rotates every sender's
 * Graine seed at its next send (`shouldRotateGraineSession`), so a refresh would mint seeds the way
 * the 2026-10-21 measurement already deplores. A group in an epoch gap: the recovery ladder owns it.
 * A group this device was removed from: it can commit nothing there. A group HELD by something
 * that needs its epoch to stay put ({@link holdLeafRefresh} - a call being set up). And a device
 * whose own context is not the base the server publishes for the epoch
 * ({@link LeafRefreshUnverifiedError}): the server's gate compares only epoch numbers, so a forked
 * device's refresh would be accepted and break every healthy member.
 *
 * @see docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { CommitRefusedError } from './CommitRefusedError';
import { CommitOutcomeUnknownError } from './unresolvedCommits';

/**
 * How long a leaf may hold the same key material before this device replaces it: SEVEN DAYS.
 *
 * Why seven: it is the Graine session's own cap, so a stolen device copy stops reading new traffic
 * after about a week in a conversation as in a community; it is twelve times inside the 84-day leaf
 * lifetime; and on the fleet measured 2026-10-21 it bounds the added commits to about one per
 * seat per week, a fraction of which actually sends (expected numbers on the wiki page above).
 */
export const LEAF_REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The most groups the ledger keeps; the oldest refresh goes first. A device sits in far fewer
 * conversations than this, so the bound only ever trims entries of groups long forgotten.
 */
export const LEAF_REFRESH_LEDGER_MAX_GROUPS = 512;

/** When this device's leaf in one group was last replaced by its own commit, and at which epoch. */
export interface LeafRefreshRecord {
  /** Unix ms of the server's accept of that commit, as this device's clock read it. */
  at: number;
  /** The epoch that commit created. */
  epoch: number;
}

/** What the age of the current leaf was read from. */
export type LeafAgeBasis = 'admission' | 'ledger' | 'first-sight';

/** Whether a refresh is owed, and the fact that decided it. */
export interface LeafRefreshDecision {
  due: boolean;
  basis: LeafAgeBasis;
  /** Since when the current key material is known to exist, Unix ms. */
  sinceMs: number;
}

/**
 * Decides whether the leaf is old enough to replace. PURE.
 *
 * `first-sight` - a commit-sourced leaf with no ledger entry (the ledger was cleared, or this build
 * is the first to keep one) - is NEVER due: dating it "now" costs at most one interval of delay,
 * while dating it "never" would turn a lost ledger into a commit in every group at the next send.
 */
export function decideLeafRefresh(input: {
  mintedAtSec: number | null;
  record: LeafRefreshRecord | undefined;
  nowMs: number;
  intervalMs?: number;
}): LeafRefreshDecision {
  const interval = input.intervalMs ?? LEAF_REFRESH_INTERVAL_MS;
  let basis: LeafAgeBasis;
  let sinceMs: number;
  if (input.mintedAtSec !== null) {
    basis = 'admission';
    sinceMs = input.mintedAtSec * 1000;
  } else if (input.record) {
    basis = 'ledger';
    sinceMs = input.record.at;
  } else {
    return { due: false, basis: 'first-sight', sinceMs: input.nowMs };
  }
  return { due: input.nowMs - sinceMs >= interval, basis, sinceMs };
}

function ledgerKey(userId: string, deviceId: string): string {
  return ACCOUNT_KEY.leafRefresh(userId, deviceId);
}

/**
 * The refresh ledger of this account on this device. An unreadable one reads as empty - which
 * makes every commit-sourced leaf a `first-sight` (never due), the direction that costs no commit -
 * and it is said, because an empty ledger and an unreadable one are different causes.
 */
export function readLeafRefreshLedger(
  userId: string,
  deviceId: string
): Record<string, LeafRefreshRecord> {
  try {
    const raw = localStorage.getItem(ledgerKey(userId, deviceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, LeafRefreshRecord>;
  } catch (e) {
    console.warn(
      `[LEAF_REFRESH] ledger unreadable for ${userId.slice(0, 8)}... - read as empty, so no ` +
        'refreshed leaf is due until it is dated again:',
      String(e).slice(0, 120)
    );
    return {};
  }
}

/**
 * Records that this device's own commit, accepted by the server, replaced its leaf in `groupId`.
 *
 * Written by `BaseMlsService.runCommitTransaction` after the merge - the one seam every own member
 * commit passes through, so a Remove or an Add counts as a refresh, as it is - and after an
 * accepted external join. A failed write costs at most one early refresh, and is said.
 */
export function noteOwnLeafRefreshed(
  userId: string,
  deviceId: string,
  groupId: string,
  epoch: number,
  nowMs: number = Date.now()
): void {
  const ledger = readLeafRefreshLedger(userId, deviceId);
  ledger[groupId] = { at: nowMs, epoch };
  const entries = Object.entries(ledger);
  const kept =
    entries.length <= LEAF_REFRESH_LEDGER_MAX_GROUPS
      ? entries
      : entries.sort((a, b) => b[1].at - a[1].at).slice(0, LEAF_REFRESH_LEDGER_MAX_GROUPS);
  try {
    localStorage.setItem(ledgerKey(userId, deviceId), JSON.stringify(Object.fromEntries(kept)));
  } catch (e) {
    console.warn(
      `[LEAF_REFRESH] could not record the refresh of ${groupId.slice(0, 8)}... at epoch ${epoch} - ` +
        'the next send may refresh it again:',
      String(e).slice(0, 120)
    );
  }
}

/** Why the server's published base could not vouch for this device's state. */
export type LeafRefreshUnverifiedReason = 'no-base' | 'other-epoch' | 'diverged';

/**
 * Thrown by `BaseMlsService.refreshOwnLeaf` BEFORE anything is staged, when this device's group
 * context is not the one the server publishes for the epoch.
 *
 * WHY: the server's commit gate compares epoch NUMBERS. A device that merged a commit nobody else
 * did sits at the right number on the wrong branch, its refresh is accepted, and every healthy
 * member then fails to apply it. A commit nobody asked for must not be what spreads a fork, so it is
 * staged only when the device's context (tree hash, confirmed transcript hash) IS the published one.
 * - `no-base`: nothing is published for the group - nothing to compare against;
 * - `other-epoch`: the published base is of another epoch (this device is behind, or the base is);
 * - `diverged`: same epoch, different hashes - THIS DEVICE IS ON ANOTHER BRANCH.
 */
export class LeafRefreshUnverifiedError extends Error {
  constructor(
    readonly groupId: string,
    readonly reason: LeafRefreshUnverifiedReason
  ) {
    super(
      `leaf refresh of ${groupId.slice(0, 8)}... not vouched for by the published base: ${reason}`
    );
    this.name = 'LeafRefreshUnverifiedError';
  }
}

/**
 * Groups whose epoch something on this device needs to stay put for a while, and why - a call
 * being set up derives its media keys from the CURRENT epoch on each end, one after the other, so
 * a refresh between the two derivations gives the ends different keys. Several holds may be taken
 * on one group; the group is held while any is.
 */
const leafRefreshHolds = new Map<string, Map<symbol, string>>();

/**
 * Holds the periodic refresh of `groupId` until the returned release is called. The release is
 * idempotent and lifts only this hold. Only the REFRESH is held - a commit a person asked for
 * (an Add, a Remove) is not this module's to delay.
 */
export function holdLeafRefresh(groupId: string, reason: string): () => void {
  const token = Symbol(reason);
  let holds = leafRefreshHolds.get(groupId);
  if (!holds) {
    holds = new Map();
    leafRefreshHolds.set(groupId, holds);
  }
  holds.set(token, reason);
  console.log(`[LEAF_REFRESH] ${groupId.slice(0, 8)}... held (${reason})`);
  return () => {
    const current = leafRefreshHolds.get(groupId);
    if (!current?.delete(token)) return;
    if (current.size === 0) leafRefreshHolds.delete(groupId);
    console.log(`[LEAF_REFRESH] ${groupId.slice(0, 8)}... hold released (${reason})`);
  };
}

/** The reason `groupId`'s refresh is held, or `null` when nothing holds it. */
export function leafRefreshHold(groupId: string): string | null {
  const holds = leafRefreshHolds.get(groupId);
  if (!holds) return null;
  return holds.values().next().value ?? null;
}

/** What one {@link refreshLeafIfDue} call did. */
export type LeafRefreshOutcome =
  | 'key-group'
  | 'inactive'
  | 'first-sight'
  | 'not-due'
  | 'epoch-gap'
  | 'held'
  | 'already-tried'
  | 'unverified'
  | 'unresolved'
  | 'refreshed'
  | 'failed';

/** What {@link refreshLeafIfDue} reads and does - the platform's MLS service, narrowed. */
export interface LeafRefreshDeps {
  userId: string;
  deviceId: string;
  isDistributionGroup(groupId: string): boolean;
  isInEpochGap(groupId: string): boolean;
  isGroupActive(groupId: string): Promise<boolean>;
  getEpoch(groupId: string): number;
  /** `own_leaf_minted_at`: Unix seconds for a KeyPackage-dated leaf, `null` for a refreshed one. */
  ownLeafMintedAt(groupId: string): Promise<number | null>;
  /** Stages, submits and merges the refresh; throws on a refusal (the ledger is written inside). */
  refreshOwnLeaf(groupId: string): Promise<void>;
  /** The structural checkpoint, awaited. */
  checkpoint(): Promise<boolean>;
  /**
   * The epoch at which a refresh of each group last FAILED in this session. A retry at the same
   * epoch faces the same answer; the epoch moving is what makes the next one different.
   */
  attemptedAtEpoch: Map<string, number>;
  now(): number;
  log(message: string): void;
}

/**
 * Replaces this device's leaf in `groupId` when it is due, and otherwise does nothing - cheaply and
 * silently, since it runs after every durable send.
 *
 * Never throws: every failure is reported and leaves the ledger untouched, so the next send after
 * the epoch moves asks again. Nothing here retries on its own.
 */
export async function refreshLeafIfDue(
  deps: LeafRefreshDeps,
  groupId: string
): Promise<LeafRefreshOutcome> {
  const short = groupId.slice(0, 8);
  if (deps.isDistributionGroup(groupId)) return 'key-group';
  if (!(await deps.isGroupActive(groupId))) return 'inactive';

  const now = deps.now();
  const decision = decideLeafRefresh({
    mintedAtSec: await deps.ownLeafMintedAt(groupId),
    record: readLeafRefreshLedger(deps.userId, deps.deviceId)[groupId],
    nowMs: now,
  });
  const epoch = deps.getEpoch(groupId);
  if (decision.basis === 'first-sight') {
    noteOwnLeafRefreshed(deps.userId, deps.deviceId, groupId, epoch, now);
    deps.log(
      `[LEAF_REFRESH] ${short}... leaf refreshed at an unknown time (no ledger entry) - dated now, ` +
        'first refresh in seven days'
    );
    return 'first-sight';
  }
  if (!decision.due) return 'not-due';

  const ageDays = ((now - decision.sinceMs) / (24 * 60 * 60 * 1000)).toFixed(1);
  if (deps.isInEpochGap(groupId)) {
    deps.log(
      `[LEAF_REFRESH] ${short}... due (${ageDays} d, ${decision.basis}) but in an epoch gap - ` +
        'left to the recovery ladder, asked again at the next send'
    );
    return 'epoch-gap';
  }
  const hold = leafRefreshHold(groupId);
  if (hold !== null) {
    deps.log(
      `[LEAF_REFRESH] ${short}... due (${ageDays} d, ${decision.basis}) but held (${hold}) - ` +
        'asked again at the next send after the hold is released'
    );
    return 'held';
  }
  if (deps.attemptedAtEpoch.get(groupId) === epoch) return 'already-tried';

  deps.log(
    `[LEAF_REFRESH] ${short}... leaf is ${ageDays} d old (${decision.basis}) at epoch ${epoch} - refreshing`
  );
  try {
    await deps.refreshOwnLeaf(groupId);
  } catch (e) {
    deps.attemptedAtEpoch.set(groupId, epoch);
    if (e instanceof LeafRefreshUnverifiedError) {
      // Nothing was staged. `diverged` is the one that accuses: this device is on a branch the
      // server does not publish, and the recovery ladder - not a refresh - is what owns that.
      deps.log(
        e.reason === 'diverged'
          ? `[LEAF_REFRESH] ${short}... NOT refreshed at epoch ${epoch}: this device's context ` +
              'DIVERGES from the published base at the same epoch (diverged) - a fork; nothing staged'
          : `[LEAF_REFRESH] ${short}... not refreshed at epoch ${epoch}: the published base cannot ` +
              `vouch for this state (${e.reason}) - nothing staged, asked again after the epoch moves`
      );
      return 'unverified';
    }
    if (e instanceof CommitOutcomeUnknownError) {
      // Neither merged nor cleared: kept, and settled by a resubmission (`unresolvedCommits.ts`),
      // which dates the leaf if the gate accepted it. Nothing here decides it.
      deps.log(
        `[LEAF_REFRESH] ${short}... refresh at epoch ${epoch} has an UNKNOWN outcome - kept pending ` +
          'until a resubmission answers'
      );
      return 'unresolved';
    }
    deps.log(
      e instanceof CommitRefusedError
        ? `[LEAF_REFRESH] ${short}... refresh refused at epoch ${epoch} (${e.reason}, server at ` +
            `${e.currentEpoch ?? '?'}) - the leaf stays, asked again at the next send after the epoch moves`
        : `[LEAF_REFRESH] ${short}... refresh FAILED at epoch ${epoch}: ${String(e).slice(0, 160)} - ` +
            'the leaf stays, asked again at the next send after the epoch moves'
    );
    return 'failed';
  }
  deps.attemptedAtEpoch.delete(groupId);
  // AWAITED: the server already holds the new epoch, and the private half of our new leaf exists
  // only in memory until this lands - the same reason the external join awaits its checkpoint.
  let checkpointed = false;
  try {
    checkpointed = await deps.checkpoint();
  } catch (e) {
    deps.log(
      `[LEAF_REFRESH] ${short}... refreshed but the checkpoint FAILED: ${String(e).slice(0, 120)}`
    );
  }
  deps.log(
    `[LEAF_REFRESH] ${short}... refreshed - epoch ${deps.getEpoch(groupId)}` +
      (checkpointed ? '' : ' (NOT checkpointed: a reload before the next write loses the new leaf)')
  );
  return 'refreshed';
}
