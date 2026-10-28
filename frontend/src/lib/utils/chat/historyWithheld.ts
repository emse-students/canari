import {
  canonicalIdentity,
  deviceIdOfLeaf,
  sameDeviceIdentity,
  userIdOfLeaf,
} from '$lib/mls-client/leafIdentity';
import { memberDeviceAnswer } from './memberDeviceAnswers';

/**
 * HISTORY IS WITHHELD FROM AN UNVERIFIED DEVICE (2026-10-27).
 *
 * A device of a member that let itself into a conversation no member added it to is written in the
 * conversation as such (`deviceNotices.svelte.ts`, `unvouched-device`). Being in the tree, it reads
 * what is said from then on; what this device holds from BEFORE is a separate gift, and this device
 * does not give it (`sendBundleChunks` and `sendFullHistoryBundle` in `groupActions.ts`):
 *
 * - no history answer is addressed to it;
 * - and no history answer in that conversation is BROADCAST while any device there is withheld,
 *   since a broadcast is read by every leaf, the withheld one included.
 *
 * WHAT IS WITHHELD SPREADS TO WHAT IT ADDS: a device added by a commit of a withheld device is
 * withheld too, and that commit lifts nothing ({@link committerIsWithheld}) - otherwise one Add by
 * the unverified device would hand its whole past to a second one.
 *
 * Lifted when a member vouches for it:
 *
 * - a commit by a device that is NOT withheld in that conversation adds that very device - a member's
 *   Add, the door a further device was owed in the first place ({@link noteDeviceAddedByAMember});
 * - or this member approved that device under the same key it entered with (`approveMemberDevice`,
 *   account-wide and for the session), read at the moment an answer would leave
 *   ({@link historyWithheldFrom}).
 *
 * PER MEMBER: each device withholds on its own verdict, and another member who did not decide the
 * entry the same way may still answer. Persisted with the device notices of the account
 * (`deviceNotices.svelte.ts`), so a restart does not lift it. Past {@link MAX_HISTORY_WITHHELD}
 * records, the ones whose device has LEFT its conversation's tree go first; a record whose device is
 * still there is never dropped - past the bound, the list grows rather than answer anyone it named.
 */
export interface WithheldDevice {
  groupId: string;
  /** The device's leaf identity, canonical. */
  identity: string;
  /** The fingerprint of the key it entered with - the key an approval must name to lift it. */
  fingerprint: string;
}

/** Past this many records, the ones whose device left its tree are dropped. */
export const MAX_HISTORY_WITHHELD = 256;

/** Whether `identity` still holds a leaf in `groupId`'s tree, or `'unreadable'`. */
export type LeafStillIn = (groupId: string, identity: string) => Promise<boolean | 'unreadable'>;

let withheld: WithheldDevice[] = [];
let persist: (() => void) | null = null;

function matches(entry: WithheldDevice, groupId: string, identity: string): boolean {
  return entry.groupId === groupId && sameDeviceIdentity(entry.identity, identity);
}

/**
 * Drops, oldest first, the records past {@link MAX_HISTORY_WITHHELD} whose device is no longer in its
 * tree. A record whose device is still there, or whose tree cannot be read, is kept: fail closed.
 */
async function trimToBound(leafStillIn: LeafStillIn): Promise<void> {
  let excess = withheld.length - MAX_HISTORY_WITHHELD;
  if (excess <= 0) return;
  const gone = new Set<WithheldDevice>();
  for (const entry of withheld) {
    if (excess === 0) break;
    if ((await leafStillIn(entry.groupId, entry.identity)) === false) {
      gone.add(entry);
      excess--;
    }
  }
  withheld = withheld.filter((e) => !gone.has(e));
  if (excess > 0) {
    console.error(
      `[HISTORY_WITHHELD] ${withheld.length} devices withheld, past the bound of ${MAX_HISTORY_WITHHELD} - every one still in its conversation (or unreadable), so none is dropped`
    );
  } else {
    console.log(
      `[HISTORY_WITHHELD] ${gone.size} record(s) of devices no longer in their conversation dropped at the bound`
    );
  }
}

/** Records `identity` as owed no history in `groupId`. Idempotent. */
export async function withholdHistoryFrom(
  groupId: string,
  identity: string,
  fingerprint: string,
  leafStillIn: LeafStillIn
): Promise<void> {
  const canonical = canonicalIdentity(identity);
  if (canonical === null) {
    console.error(`[HISTORY_WITHHELD] ${identity} names no device - nothing recorded`);
    return;
  }
  if (withheld.some((e) => matches(e, groupId, canonical) && e.fingerprint === fingerprint)) return;
  withheld = [
    ...withheld.filter((e) => !matches(e, groupId, canonical)),
    { groupId, identity: canonical, fingerprint },
  ];
  console.warn(
    `[HISTORY_WITHHELD] no history is answered to ${canonical} in ${groupId.slice(0, 8)}... until a member vouches for it`
  );
  await trimToBound(leafStillIn);
  persist?.();
}

function lift(groupId: string, identity: string, why: string): void {
  const before = withheld.length;
  withheld = withheld.filter((e) => !matches(e, groupId, identity));
  if (withheld.length === before) return;
  console.log(`[HISTORY_WITHHELD] ${identity} in ${groupId.slice(0, 8)}... answered again: ${why}`);
  persist?.();
}

/**
 * Whether the commit that added a device was made by a device withheld in that conversation (and
 * not by the added device itself): what such a commit adds is withheld too.
 */
export function committerIsWithheld(
  groupId: string,
  identity: string,
  addedBy: string | null
): boolean {
  if (addedBy === null || sameDeviceIdentity(addedBy, identity)) return false;
  return historyWithheldFrom(groupId, addedBy);
}

/**
 * A commit added `identity` to `groupId` (`addedBy` a device other than itself). By a device that is
 * not withheld there, that Add is the vouching and history is answered to it again; by a withheld
 * one it lifts nothing ({@link committerIsWithheld}).
 */
export function noteDeviceAddedByAMember(
  groupId: string,
  identity: string,
  addedBy: string | null
): void {
  if (addedBy === null || sameDeviceIdentity(addedBy, identity)) return;
  if (!withheld.some((e) => matches(e, groupId, identity))) return;
  if (committerIsWithheld(groupId, identity, addedBy)) {
    console.warn(
      `[HISTORY_WITHHELD] ${identity} in ${groupId.slice(0, 8)}... re-added by ${addedBy}, itself withheld there - still withheld`
    );
    return;
  }
  lift(groupId, identity, `a member's commit added it (${addedBy})`);
}

/**
 * Whether a history answer to `to` in `groupId` is withheld. Lifted here when this member has
 * approved that device under the key it entered with - the approval is session-scoped and may come
 * after the record.
 */
export function historyWithheldFrom(groupId: string, to: string): boolean {
  const entry = withheld.find((e) => matches(e, groupId, to));
  if (!entry) return false;
  const answer = memberDeviceAnswer(
    groupId,
    userIdOfLeaf(entry.identity),
    deviceIdOfLeaf(entry.identity)
  );
  if (answer?.kind === 'approved' && answer.fingerprint === entry.fingerprint) {
    lift(groupId, entry.identity, 'this member approved it under the key it entered with');
    return false;
  }
  return true;
}

/**
 * Whether any device is withheld in `groupId` - then no history answer there may be broadcast,
 * since every leaf reads a broadcast.
 */
export function anyHistoryWithheldIn(groupId: string): boolean {
  return withheld
    .filter((e) => e.groupId === groupId)
    .some((e) => historyWithheldFrom(groupId, e.identity));
}

/** The records, for the account's persisted notices. */
export function historyWithheldEntries(): WithheldDevice[] {
  return [...withheld];
}

/**
 * Binds the records to an account: `entries` restored from its notices (or `[]` on unbinding), and
 * `onChange` what persists them again. Nothing restored is dropped: the bound is applied when a
 * record is added, against the trees.
 */
export function bindHistoryWithheld(
  entries: readonly WithheldDevice[],
  onChange: (() => void) | null
): void {
  withheld = [...entries];
  persist = onChange;
}

/** Whether a persisted value is a {@link WithheldDevice}. */
export function isWithheldDevice(v: unknown): v is WithheldDevice {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.groupId === 'string' &&
    typeof o.identity === 'string' &&
    typeof o.fingerprint === 'string'
  );
}
