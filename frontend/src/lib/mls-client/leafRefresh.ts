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
 * No randomness and no clock-driven loop: two runs over the same state decide the same thing.
 *
 * **THE AGE OF THE LEAF, AND WHERE EACH HALF OF IT LIVES.**
 * - A leaf ADMITTED from a KeyPackage is dated by the TREE (`own_leaf_minted_at`: the package's
 *   `not_before`), so that date cannot be lost with any bookkeeping of ours.
 * - A leaf produced by a commit carries no date, and EVERY commit this device makes produces one
 *   (openmls puts a path in every member commit it builds - pinned by `mls-core/tests/self_update.rs`).
 *   So {@link noteOwnLeafRefreshed} is written by the one seam every own commit passes through,
 *   after the server accepted it - a refresh, a Remove and an Add alike - and by the external join.
 *
 * **EVERY ENTRY NAMES THE LEAF IT DATES** (`leaf`: the leaf's HPKE key, `own_leaf_encryption_key`),
 * and an entry naming another leaf dates nothing. The ledger lives in `localStorage`, which Chrome
 * commits to disk LAZILY - a write reaches the profile about five seconds after it is made (measured
 * 2026-10-25) - while the merge it follows is in the MLS state, on disk the moment its checkpoint
 * completes. An unclean exit between the two (a browser killed, an app swiped away) keeps the merge
 * and loses the entry, and the relaunch read the entry the disk kept: written for the leaf the merge
 * REPLACED, often due, so the first send refreshed a leaf one minute old (KILL-2, 1.4.1-alpha.4).
 * The key is read from the state itself, so the two can no longer disagree unseen: a former leaf's
 * entry is a first sight, observed again - the direction that costs no commit.
 *
 * **THE FIRST REFRESH IS SPREAD, OR IT IS A HERD.** The day this mechanism ships, every leaf in every
 * group is older than the interval, so a decision on age alone makes each seat refresh at its first
 * send: ~1600 commits in the first week, back to back in a 109-seat group, where a slow device keeps
 * only two past epochs (`max_past_epochs`) and loses the frames sealed before the ones it missed.
 * So a leaf this device has no refresh of its own for is first OBSERVED (a ledger entry, written at
 * its first send, never due then), and becomes due at the observation plus a fixed offset in
 * `[0, interval)` derived from `(deviceId, groupId)` ({@link leafRefreshOffsetMs}) - the seats of
 * one group land on different days of the week, the same days at every run. After that first
 * refresh each seat's next one follows its own, so the spread holds without being re-applied.
 *
 * **THE CLOCK IS THIS DEVICE'S, AND THAT IS ACKNOWLEDGED, NOT DERIVED AWAY.** The interval is a
 * duration, and no durable MLS fact measures one: an epoch moves on commits, so a quiet group would
 * never be due and a busy one would be due hourly. What a WRONG clock costs: it decides only WHEN a
 * refresh is owed, never what a commit contains. A clock ahead makes refreshes early - at most one
 * per group per forward jump, since the refresh it causes is dated by the same clock; a clock behind
 * makes them late. A ledger date in the FUTURE (the clock that wrote it was ahead and has come back)
 * is not believed: the leaf is observed again, so the delay is bounded by one interval rather than
 * by however far ahead that clock was.
 *
 * **WHERE IT MUST NOT RUN.** A community's key group, for its cost: a refresh there is not a
 * departure, so it does not rotate the Graine seeds by itself (`graineOutboundVerdict`), but it
 * moves the epoch, and every sender's next send then re-distributes its seed - one frame per sender
 * per refresh - and a re-distributed session takes the tighter caps (50 messages, 24 hours FROM ITS
 * MINT), so any session already past a day ROTATES instead. Kept out until that cost is weighed
 * against the key group's own healing (`docs/wiki/backlog.md`). A group in an epoch gap: the
 * recovery ladder owns it. A group this device was removed from: it can commit nothing there. A
 * group HELD by something that needs its epoch to stay put ({@link holdLeafRefresh} - a call being
 * set up). And a device whose own context is not the base the server publishes for the epoch
 * ({@link UnpublishedBranchError}, `publishedBranch.ts`).
 *
 * @see docs/wiki/protocols/mls-protocol.md#the-periodic-leaf-refresh
 */
import { ACCOUNT_KEY } from '$lib/utils/accountLocalKeys';
import { mixedHash32 } from '$lib/utils/hash32';
import { CommitRefusedError } from './CommitRefusedError';
import { CommitOutcomeUnknownError, FollowerTabCommitError } from './commitSubmission';
import { UnpublishedBranchError } from './publishedBranch';

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
 * The most groups the ledger keeps; the oldest entry goes first. A device sits in far fewer
 * conversations than this, so the bound only ever trims entries of groups long forgotten.
 */
export const LEAF_REFRESH_LEDGER_MAX_GROUPS = 512;

/**
 * One group's ledger entry: either this device's own accepted commit replaced its leaf (a REFRESH),
 * or this device first saw a leaf it holds no refresh of its own for (an OBSERVATION).
 */
export interface LeafRefreshRecord {
  /** Unix ms of the server's accept of that commit, or of the observation, by this device's clock. */
  at: number;
  /** The epoch that commit created, or the epoch at the observation. */
  epoch: number;
  /**
   * Present on an OBSERVATION only. It is not a refresh: it anchors the first one
   * ({@link leafRefreshOffsetMs}).
   */
  observed?: true;
  /**
   * The leaf this entry dates, as `own_leaf_encryption_key` reads it (hex). An entry is read only
   * for the leaf it names; one without it predates the naming and describes no leaf.
   */
  leaf?: string;
}

/**
 * What the age of the current leaf was read from: its KeyPackage (`admission`), this device's own
 * refresh (`ledger`), an earlier observation of a commit-sourced leaf (`observed`), or nothing yet
 * (`first-sight`, which records an observation and is never due).
 */
export type LeafAgeBasis = 'admission' | 'ledger' | 'observed' | 'first-sight';

/** Whether a refresh is owed, and the fact that decided it. */
export interface LeafRefreshDecision {
  due: boolean;
  basis: LeafAgeBasis;
  /** Since when the current key material is known to exist (or was first seen), Unix ms. */
  sinceMs: number;
  /** From when the refresh is owed, Unix ms; `null` on a first sight. */
  dueAtMs: number | null;
  /** On a first sight: the ledger held an entry, written for ANOTHER leaf (or naming none). */
  formerLeaf?: true;
}

/**
 * The fixed offset, in `[0, intervalMs)`, at which this device's first refresh in `groupId` falls
 * after it first observed the leaf. PURE and DETERMINISTIC: derived from `(deviceId, groupId)` and
 * nothing else - not a clock, not a random draw per run - so a reload, a second tab or a retry all
 * read the same day, and the seats of one group spread evenly over the interval.
 */
export function leafRefreshOffsetMs(
  deviceId: string,
  groupId: string,
  intervalMs: number = LEAF_REFRESH_INTERVAL_MS
): number {
  return Math.floor((mixedHash32(`${deviceId}|${groupId}`) / 2 ** 32) * intervalMs);
}

/**
 * Decides whether the leaf is old enough to replace. PURE.
 *
 * An entry is read only for the leaf it NAMES (`record.leaf === leaf`): the ledger is written after
 * the merge, into a store an unclean exit can lose while the merge survives (see the header), so an
 * entry naming another leaf dates a former one - whatever kind it is.
 *
 * - A KeyPackage-dated leaf (`mintedAtSec`) is due at the LATER of `minted + interval` and its
 *   observation plus the offset. A ledger REFRESH beside it cannot name it (a refresh leaves a
 *   commit-sourced leaf), so only an observation counts.
 * - A leaf this device's own commit produced is due at `refresh + interval` (`ledger`).
 * - A commit-sourced leaf with only an observation is due at the observation plus the offset.
 * - Anything else - no entry, an entry of another leaf, or one dated in the future - is a
 *   `first-sight`: NEVER due, and the caller records an observation. Dating it "now" costs at most
 *   one interval of delay, while dating it "never" would turn a lost ledger into a commit in every
 *   group at the next send.
 */
export function decideLeafRefresh(input: {
  mintedAtSec: number | null;
  /** The current leaf, as `own_leaf_encryption_key` reads it (hex). */
  leaf: string;
  record: LeafRefreshRecord | undefined;
  nowMs: number;
  offsetMs: number;
  intervalMs?: number;
}): LeafRefreshDecision {
  const interval = input.intervalMs ?? LEAF_REFRESH_INTERVAL_MS;
  const { mintedAtSec, nowMs, offsetMs } = input;
  // A date this device's clock has not reached yet was written by a clock that was ahead: believing
  // it would postpone the refresh by however far ahead that clock was. Observed again instead.
  const current = input.record && input.record.at <= nowMs ? input.record : undefined;
  const record = current?.leaf === input.leaf ? current : undefined;
  const observation = record?.observed ? record : undefined;
  const firstSight: LeafRefreshDecision = {
    due: false,
    basis: 'first-sight',
    sinceMs: nowMs,
    dueAtMs: null,
    ...(current && !record ? { formerLeaf: true as const } : {}),
  };

  let basis: LeafAgeBasis;
  let sinceMs: number;
  let dueAtMs: number;
  if (mintedAtSec !== null) {
    if (!observation) return firstSight;
    basis = 'admission';
    sinceMs = mintedAtSec * 1000;
    dueAtMs = Math.max(sinceMs + interval, observation.at + offsetMs);
  } else if (record && !record.observed) {
    basis = 'ledger';
    sinceMs = record.at;
    dueAtMs = record.at + interval;
  } else if (observation) {
    basis = 'observed';
    sinceMs = observation.at;
    dueAtMs = observation.at + offsetMs;
  } else {
    return firstSight;
  }
  return { due: nowMs >= dueAtMs, basis, sinceMs, dueAtMs };
}

function ledgerKey(userId: string, deviceId: string): string {
  return ACCOUNT_KEY.leafRefresh(userId, deviceId);
}

/**
 * The refresh ledger of this account on this device. An unreadable one reads as empty - which
 * makes every leaf a `first-sight` (never due), the direction that costs no commit - and it is
 * said, because an empty ledger and an unreadable one are different causes.
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
        'leaf is due until it is observed again:',
      String(e).slice(0, 120)
    );
    return {};
  }
}

/** Writes one group's entry, bounded to the newest {@link LEAF_REFRESH_LEDGER_MAX_GROUPS}. */
function writeLedgerEntry(
  userId: string,
  deviceId: string,
  groupId: string,
  record: LeafRefreshRecord,
  what: string
): void {
  const ledger = readLeafRefreshLedger(userId, deviceId);
  ledger[groupId] = record;
  const entries = Object.entries(ledger);
  const kept =
    entries.length <= LEAF_REFRESH_LEDGER_MAX_GROUPS
      ? entries
      : entries.sort((a, b) => b[1].at - a[1].at).slice(0, LEAF_REFRESH_LEDGER_MAX_GROUPS);
  try {
    localStorage.setItem(ledgerKey(userId, deviceId), JSON.stringify(Object.fromEntries(kept)));
  } catch (e) {
    console.warn(
      `[LEAF_REFRESH] could not record the ${what} of ${groupId.slice(0, 8)}... at epoch ` +
        `${record.epoch} - the next send decides from the entry before it:`,
      String(e).slice(0, 120)
    );
  }
}

/**
 * Records that this device's own commit, accepted by the server, replaced its leaf in `groupId` with
 * `leaf` (its key, read after the merge).
 *
 * Written by `BaseMlsService.noteOwnLeafReplaced`, which every merge of an own commit reaches - a
 * Remove or an Add counts as a refresh, as it is - and the accepted external join. A write that
 * fails, or that an unclean exit loses, leaves an entry naming the former leaf: the next send
 * observes the leaf instead of refreshing it ({@link decideLeafRefresh}). A failed write is said.
 */
export function noteOwnLeafRefreshed(
  userId: string,
  deviceId: string,
  groupId: string,
  epoch: number,
  leaf: string,
  nowMs: number = Date.now()
): void {
  writeLedgerEntry(userId, deviceId, groupId, { at: nowMs, epoch, leaf }, 'refresh');
}

/**
 * Records the first sight of `leaf`, a leaf this device holds no refresh of its own for - the anchor
 * its first refresh is spread from ({@link decideLeafRefresh}). The entry names the leaf, so it is
 * never read for another one. A failed write leaves the leaf a first sight at the next send, which
 * commits nothing, and is said.
 */
export function noteLeafObserved(
  userId: string,
  deviceId: string,
  groupId: string,
  epoch: number,
  leaf: string,
  nowMs: number
): void {
  writeLedgerEntry(
    userId,
    deviceId,
    groupId,
    { at: nowMs, epoch, observed: true, leaf },
    'observation'
  );
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
  | 'follower-tab'
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
  /** `own_leaf_encryption_key` as hex - what names the current leaf - or `null` with no own leaf. */
  ownLeafKey(groupId: string): Promise<string | null>;
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
  const leaf = await deps.ownLeafKey(groupId);
  if (leaf === null) {
    // An active group whose tree holds no leaf of ours: nothing to refresh, and nothing to date.
    deps.log(`[LEAF_REFRESH] ${short}... no own leaf in the tree - nothing to refresh`);
    return 'inactive';
  }
  const mintedAtSec = await deps.ownLeafMintedAt(groupId);
  const offsetMs = leafRefreshOffsetMs(deps.deviceId, groupId);
  const decision = decideLeafRefresh({
    mintedAtSec,
    leaf,
    record: readLeafRefreshLedger(deps.userId, deps.deviceId)[groupId],
    nowMs: now,
    offsetMs,
  });
  const epoch = deps.getEpoch(groupId);
  if (decision.basis === 'first-sight') {
    noteLeafObserved(deps.userId, deps.deviceId, groupId, epoch, leaf, now);
    deps.log(
      `[LEAF_REFRESH] ${short}... first sight of this leaf (${mintedAtSec === null ? 'commit-sourced' : 'admitted'}, ` +
        (decision.formerLeaf
          ? 'the entry on record dates a FORMER leaf - its write after our last merge did not ' +
            'survive, or it predates the naming of leaves'
          : 'no refresh of ours on record') +
        ') - observed now, its first refresh is owed from ' +
        `${(offsetMs / (24 * 60 * 60 * 1000)).toFixed(1)} d after this` +
        (mintedAtSec === null ? '' : ' or seven days after its admission, whichever is later')
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
    if (e instanceof UnpublishedBranchError) {
      // Nothing was staged. `diverged` is the one that accuses, and it was handed to the recovery
      // ladder where it was thrown (`BaseMlsService.assertOnPublishedBranch`): this only says so.
      deps.log(
        e.reason === 'diverged'
          ? `[LEAF_REFRESH] ${short}... NOT refreshed at epoch ${epoch}: this device's context ` +
              'DIVERGES from the published base at the same epoch (diverged: a fork) - nothing staged, the ' +
              'group is handed to the recovery ladder'
          : `[LEAF_REFRESH] ${short}... not refreshed at epoch ${epoch}: the published base cannot ` +
              `vouch for this state (${e.reason}) - nothing staged, asked again after the epoch moves`
      );
      return 'unverified';
    }
    if (e instanceof CommitOutcomeUnknownError) {
      // Neither merged nor cleared: kept, and settled by a resubmission (`commitSubmission.ts`),
      // which dates the leaf if the gate accepted it. Nothing here decides it.
      deps.log(
        `[LEAF_REFRESH] ${short}... refresh at epoch ${epoch} has an UNKNOWN outcome - kept pending ` +
          'until a resubmission answers'
      );
      return 'unresolved';
    }
    if (e instanceof FollowerTabCommitError) {
      // Not a failure: a follower tab never commits, and refused before fetching anything
      // (`BaseMlsService.refreshOwnLeaf`, which said so). The leader tab refreshes the leaf.
      return 'follower-tab';
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
  // AWAITED, SO THE MERGE IS ON DISK - not so the new leaf survives: the stage and its submission
  // record reached disk before the commit left (`checkpointStageBeforeSend`), so a reload before
  // this lands finds the refresh STAGED, and its resubmission (answered `duplicate`) merges it.
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
      (checkpointed
        ? ''
        : ' (merge NOT checkpointed: a reload before the next write finds the refresh staged, and ' +
          'its resubmission at the next connection merges it)')
  );
  return 'refreshed';
}
