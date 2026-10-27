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
 * does not give it - every history answer addressed to it is withheld (`sendBundleChunks` in
 * `groupActions.ts`) until a member vouches for it:
 *
 * - a member's commit adds that very device (`addedBy` another device) - the member's Add, the door
 *   a further device was owed in the first place ({@link noteDeviceAddedByAMember});
 * - or this member approved that device under the same key it entered with (`approveMemberDevice`),
 *   read at the moment an answer would leave ({@link historyWithheldFrom}).
 *
 * Persisted with the device notices of the account (`deviceNotices.svelte.ts`), so a restart does not
 * lift it, and bounded: past {@link MAX_HISTORY_WITHHELD} the oldest record goes, said at a level
 * that accuses.
 */
export interface WithheldDevice {
  groupId: string;
  /** The device's leaf identity, canonical. */
  identity: string;
  /** The fingerprint of the key it entered with - the key an approval must name to lift it. */
  fingerprint: string;
}

/** How many withheld devices an account remembers. */
export const MAX_HISTORY_WITHHELD = 256;

let withheld: WithheldDevice[] = [];
let persist: (() => void) | null = null;

function matches(entry: WithheldDevice, groupId: string, identity: string): boolean {
  return entry.groupId === groupId && sameDeviceIdentity(entry.identity, identity);
}

/** Records `identity` as owed no history in `groupId`. Idempotent. */
export function withholdHistoryFrom(groupId: string, identity: string, fingerprint: string): void {
  const canonical = canonicalIdentity(identity);
  if (canonical === null) {
    console.error(`[HISTORY_WITHHELD] ${identity} names no device - nothing recorded`);
    return;
  }
  if (withheld.some((e) => matches(e, groupId, canonical) && e.fingerprint === fingerprint)) return;
  const next = [
    ...withheld.filter((e) => !matches(e, groupId, canonical)),
    { groupId, identity: canonical, fingerprint },
  ];
  if (next.length > MAX_HISTORY_WITHHELD) {
    console.error(
      `[HISTORY_WITHHELD] more than ${MAX_HISTORY_WITHHELD} devices withheld - the oldest record goes, its device is answered again`
    );
  }
  withheld = next.slice(-MAX_HISTORY_WITHHELD);
  console.warn(
    `[HISTORY_WITHHELD] no history is answered to ${canonical} in ${groupId.slice(0, 8)}... until a member vouches for it`
  );
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
 * A member's commit added `identity` to `groupId` (`addedBy` a device other than itself): that Add is
 * the vouching, and history is answered to it again.
 */
export function noteDeviceAddedByAMember(
  groupId: string,
  identity: string,
  addedBy: string | null
): void {
  if (addedBy === null || sameDeviceIdentity(addedBy, identity)) return;
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

/** The records, for the account's persisted notices. */
export function historyWithheldEntries(): WithheldDevice[] {
  return [...withheld];
}

/**
 * Binds the records to an account: `entries` restored from its notices (or `[]` on unbinding), and
 * `onChange` what persists them again.
 */
export function bindHistoryWithheld(
  entries: readonly WithheldDevice[],
  onChange: (() => void) | null
): void {
  withheld = entries.slice(-MAX_HISTORY_WITHHELD);
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
