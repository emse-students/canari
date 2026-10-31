import { canonicalIdentity, sameDeviceIdentity } from '$lib/mls-client/leafIdentity';

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
 * Lifted when a member vouches for it: a commit by a device that is NOT withheld in that
 * conversation adds that very device - a member's Add, the door a further device is owed
 * ({@link noteDeviceAddedByAMember}). There is no tap that lifts it since 2026-10-31: a member's
 * device is never asked about (the gate is on the user), so nothing approves one by hand.
 *
 * PER MEMBER: each device withholds on its own verdict, and another member who did not decide the
 * entry the same way may still answer. Held in memory for the session, and persisted with the device
 * notices of the account (`deviceNotices.svelte.ts`), so a restart does not lift it.
 *
 * BOUNDED WITHOUT EVER RE-OPENING: past {@link MAX_HISTORY_WITHHELD} records in all, only the ones
 * of conversations this device no longer holds are dropped; a record of a conversation still held is
 * never dropped, its device present or not. A conversation whose device events were dropped
 * upstream is sealed ({@link sealHistoryIn}). Past {@link MAX_WITHHELD_PER_GROUP} withheld
 * devices still in ONE conversation, that conversation is SEALED: no history is answered there to
 * anyone, for good, said once at ERROR - fail closed, at a size no honest conversation reaches. The
 * seal gates answers only, never who an Add is marked against. Past as many DEPARTED withheld devices
 * in one conversation still held, it is sealed the same way and those records are dropped: a churn of
 * entries and removals cannot grow the list, and the seal keeps it closed.
 */
export interface WithheldDevice {
  groupId: string;
  /** The device's leaf identity, canonical. */
  identity: string;
  /** The fingerprint of the key it entered with. */
  fingerprint: string;
}

/** Past this many records, the ones of conversations this device no longer holds are dropped. */
export const MAX_HISTORY_WITHHELD = 256;

/**
 * Past this many withheld devices in one conversation - still in its tree, or departed from it - it
 * is sealed: no history answered there.
 */
export const MAX_WITHHELD_PER_GROUP = 32;

/**
 * Whether `identity` still holds a leaf in `groupId`'s tree; `'unreadable'` when the read failed (the
 * record is kept), `'group-not-held'` when this device no longer holds the conversation at all.
 */
export type LeafStillIn = (
  groupId: string,
  identity: string
) => Promise<boolean | 'unreadable' | 'group-not-held'>;

let withheld: WithheldDevice[] = [];
/** The conversations past {@link MAX_WITHHELD_PER_GROUP}: no history answered there at all. */
let sealed = new Set<string>();
let persist: (() => void) | null = null;
/** Whether the bound being full was said this session - once, not at every record. */
let fullReported = false;
/**
 * The records this session removed ON PURPOSE - a lift, a replacement under a new key, the trim, the
 * departed bound - by {@link recordKey}, and not yet written: the stored copy still holding one of
 * them predates the removal, so a merge ({@link adoptHistoryRecords}) does not bring it back. Once
 * the removal is written ({@link historyWithheldWritten}), a record that re-appears in storage is a
 * newer fact from another tab and is adopted.
 */
let withdrawn = new Set<string>();

/** One record's identity across tabs: conversation, device and the key it entered with. */
function recordKey(e: WithheldDevice): string {
  return `${e.groupId}\n${e.identity}\n${e.fingerprint}`;
}

/** Removes `gone` from the records, remembered as withdrawn ({@link withdrawn}). */
function withdraw(gone: (e: WithheldDevice) => boolean): number {
  const before = withheld.length;
  withheld = withheld.filter((e) => {
    if (!gone(e)) return true;
    withdrawn.add(recordKey(e));
    return false;
  });
  return before - withheld.length;
}

function matches(entry: WithheldDevice, groupId: string, identity: string): boolean {
  return entry.groupId === groupId && sameDeviceIdentity(entry.identity, identity);
}

/**
 * Drops, oldest first, the records past {@link MAX_HISTORY_WITHHELD} of conversations this device no
 * longer holds - and ONLY those. A record whose device left a conversation still held is kept: the
 * device could come back by its own commit under its pinned key, which no event announces, and the
 * record is then all that withholds from it. Past the bound with nothing to drop, the list grows:
 * fail closed, said once per session.
 */
async function trimToBound(leafStillIn: LeafStillIn): Promise<void> {
  let excess = withheld.length - MAX_HISTORY_WITHHELD;
  if (excess <= 0) return;
  const notHeld = new Map<string, boolean>();
  const gone = new Set<WithheldDevice>();
  for (const entry of withheld) {
    if (excess === 0) break;
    if (!notHeld.has(entry.groupId)) {
      notHeld.set(
        entry.groupId,
        (await leafStillIn(entry.groupId, entry.identity)) === 'group-not-held'
      );
    }
    if (!notHeld.get(entry.groupId)) continue;
    gone.add(entry);
    excess--;
  }
  withdraw((e) => gone.has(e));
  if (gone.size > 0) {
    console.log(
      `[HISTORY_WITHHELD] ${gone.size} record(s) of conversations no longer held dropped at the bound`
    );
  }
  if (excess > 0 && !fullReported) {
    fullReported = true;
    console.error(
      `[HISTORY_WITHHELD] ${withheld.length} devices withheld, past the bound of ${MAX_HISTORY_WITHHELD} - every one in a conversation still held, so none is dropped`
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
  // The same device under another key: that record is replaced, not kept beside this one.
  withdraw((e) => matches(e, groupId, canonical));
  withheld = [...withheld, { groupId, identity: canonical, fingerprint }];
  withdrawn.delete(recordKey({ groupId, identity: canonical, fingerprint }));
  console.warn(
    `[HISTORY_WITHHELD] no history is answered to ${canonical} in ${groupId.slice(0, 8)}... until a member vouches for it`
  );
  const { present, departed } = await countIn(groupId, leafStillIn);
  if (!sealed.has(groupId) && present > MAX_WITHHELD_PER_GROUP) {
    sealed = new Set([...sealed, groupId]);
    console.error(
      `[HISTORY_WITHHELD] more than ${MAX_WITHHELD_PER_GROUP} devices withheld in ${groupId.slice(0, 8)}... - the conversation is sealed, no history is answered there to anyone`
    );
  }
  if (departed.size > MAX_WITHHELD_PER_GROUP) {
    // A CHURN IN ONE CONVERSATION STILL HELD: its departed records are never trimmed (one could come
    // back), so they are bounded here - the conversation is sealed, then they are dropped.
    if (!sealed.has(groupId)) {
      sealed = new Set([...sealed, groupId]);
      console.error(
        `[HISTORY_WITHHELD] more than ${MAX_WITHHELD_PER_GROUP} withheld devices left ${groupId.slice(0, 8)}... - the conversation is sealed, no history is answered there to anyone`
      );
    }
    withdraw((e) => departed.has(e));
    console.warn(
      `[HISTORY_WITHHELD] ${departed.size} departed record(s) of sealed ${groupId.slice(0, 8)}... dropped`
    );
  }
  await trimToBound(leafStillIn);
  persist?.();
}

/**
 * How many withheld devices of `groupId` still hold a leaf there (an unreadable tree counts all), and
 * the records whose device has left it.
 */
async function countIn(
  groupId: string,
  leafStillIn: LeafStillIn
): Promise<{ present: number; departed: Set<WithheldDevice> }> {
  let present = 0;
  const departed = new Set<WithheldDevice>();
  for (const entry of withheld) {
    if (entry.groupId !== groupId) continue;
    const there = await leafStillIn(groupId, entry.identity);
    if (there === true || there === 'unreadable') present++;
    else if (there === false) departed.add(entry);
  }
  return { present, departed };
}

function lift(groupId: string, identity: string, why: string): void {
  if (withdraw((e) => matches(e, groupId, identity)) === 0) return;
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
  // THE RECORD, NEVER THE SEAL: a sealed conversation answers nobody, but that says nothing about
  // who made an Add - reading the seal here would mark every later Add there as unvouched.
  return recordWithholds(groupId, addedBy);
}

/**
 * Seals `groupId`: no history is answered there to anyone, for good - the fail-closed answer to a
 * record this device knows to be incomplete. Said once per conversation.
 */
export function sealHistoryIn(groupId: string, why: string): void {
  if (sealed.has(groupId)) return;
  sealed = new Set([...sealed, groupId]);
  console.error(
    `[HISTORY_WITHHELD] ${groupId.slice(0, 8)}... sealed - ${why}; no history is answered there to anyone`
  );
  persist?.();
}

/**
 * Adds seals written elsewhere (another tab, an account's stored copy) to this session's set, with no
 * write of its own - the caller is writing already.
 */
export function adoptHistorySeals(groupIds: readonly string[]): void {
  const added = groupIds.filter((g) => !sealed.has(g));
  if (added.length === 0) return;
  sealed = new Set([...sealed, ...added]);
  console.warn(`[HISTORY_WITHHELD] ${added.length} seal(s) written elsewhere adopted`);
}

/**
 * Adds the records another tab wrote to the stored copy since this one read it, with no write of its
 * own - the caller is writing already. A record this session withdrew is not brought back; one
 * another tab withdrew comes back from this tab's memory - a merge errs towards withholding.
 */
export function adoptHistoryRecords(stored: readonly WithheldDevice[]): void {
  let adopted = 0;
  for (const e of stored) {
    const key = recordKey(e);
    if (withdrawn.has(key) || withheld.some((h) => recordKey(h) === key)) continue;
    // ONE RECORD PER DEVICE: the same device under another key here was replaced in another tab -
    // the stored one is the newer fact, and two would let a lift of either leave the other.
    withheld = [...withheld.filter((h) => !matches(h, e.groupId, e.identity)), e];
    adopted++;
  }
  if (adopted > 0) {
    console.log(`[HISTORY_WITHHELD] ${adopted} record(s) written by another tab adopted`);
  }
}

/**
 * Says the records as they stand were written to the stored copy: the removals of this session are
 * in it now, so what re-appears there later is another tab's newer fact ({@link withdrawn}).
 */
export function historyWithheldWritten(): void {
  withdrawn = new Set();
}

/**
 * Whether a device event inherits the withholding of its committer ({@link committerIsWithheld}). A
 * device added back under its pinned key emits no event at all, so it never reaches here; the trim
 * keeps the record of a departed device for as long as its conversation is held.
 */
export function inheritsWithholding(event: {
  groupId: string;
  identity: string;
  addedBy: string | null;
}): boolean {
  return committerIsWithheld(event.groupId, event.identity, event.addedBy);
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

/** Whether a history answer to `to` in `groupId` is withheld. */
export function historyWithheldFrom(groupId: string, to: string): boolean {
  return sealed.has(groupId) || recordWithholds(groupId, to);
}

/** Whether a record withholds `to` in `groupId` - the record alone, never the seal. */
function recordWithholds(groupId: string, to: string): boolean {
  return withheld.some((e) => matches(e, groupId, to));
}

/**
 * Whether a device withheld in `groupId` still holds a leaf in its tree - then no history answer
 * there may be broadcast, since every leaf reads a broadcast. A record whose device left the tree does
 * not count; a sealed conversation always does. The tree is read (`readLeaves`) only when the
 * conversation has a record at all, and a tree that cannot be read counts as withheld: fail closed.
 */
export async function anyHistoryWithheldIn(
  groupId: string,
  readLeaves: () => Promise<readonly string[]>
): Promise<boolean> {
  if (sealed.has(groupId)) return true;
  const records = withheld.filter((e) => e.groupId === groupId);
  if (records.length === 0) return false;
  let leaves: readonly string[];
  try {
    leaves = await readLeaves();
  } catch (e) {
    console.warn(
      `[HISTORY_WITHHELD] tree of ${groupId.slice(0, 8)}... unreadable - its withheld devices are taken as present: ${String(e)}`
    );
    return true;
  }
  return records.some(
    (e) =>
      leaves.some((leaf) => sameDeviceIdentity(leaf, e.identity)) &&
      recordWithholds(groupId, e.identity)
  );
}

/** The sealed conversations, for the account's persisted notices. */
export function historySealedGroups(): string[] {
  return [...sealed];
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
  onChange: (() => void) | null,
  sealedGroups: readonly string[] = []
): void {
  withheld = [...entries];
  withdrawn = new Set();
  sealed = new Set(sealedGroups);
  persist = onChange;
  fullReported = false;
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
