/**
 * Who each group's ratchet tree holds, as last read on THIS device - the member half of an unnamed
 * group's label (`unnamedGroupLabel.ts`; docs/wiki/frontend/modules/chat.md#one-new-discussion-panel).
 *
 * REACTIVE, because the label is drawn by `$derived` readers (the list, the header, the share
 * sheet) that must redraw when somebody joins or leaves - a plain Map notifies nobody.
 *
 * WHEN IT IS READ. A tree changes only when this device merges a commit or installs a Welcome, so
 * those are the moments it is re-read: every inbound commit and every Welcome
 * (`setupMessageHandler`), every commit of this device's own (`BaseMlsService`, the one merge both
 * the transaction and a settlement go through). A group first drawn before any of them - every
 * group, at launch - is read on sight ({@link ensureGroupTreeMembers}). No timer is involved: a
 * label is stale exactly as long as a commit this device has not merged, which is the same window
 * in which it cannot read the group's messages either.
 *
 * WHAT IS KEPT is user ids only - never a name, and nothing leaves the device.
 */

import { SvelteMap } from 'svelte/reactivity';
import { composeUnnamedGroupLabel, memberUserIdsOfTree } from './unnamedGroupLabel';
import {
  getUserDisplayNameSync,
  getUserFirstNameSync,
  resolveUserDisplayName,
} from '$lib/utils/users/displayName';

/**
 * What the session offers: the FACT of holding a group (`holdsGroupState`, synchronous) and the read
 * of its leaf identities (`userId:deviceId`), which throws when the group is not held. The fact is
 * asked first, so a refusal is never how this module learns a group is absent.
 */
export interface GroupTreeReader {
  holds: (groupId: string) => boolean;
  read: (groupId: string) => Promise<string[]>;
}

const membersByGroup = new SvelteMap<string, readonly string[]>();
/**
 * The newest read asked for each group. A read that finishes after a newer one was asked is
 * dropped: two reads of the same group can straddle a commit, and the older answer landing last
 * would put a departed member back on the label until the next commit.
 */
const latestRead = new Map<string, number>();
let readSeq = 0;
let reader: GroupTreeReader | null = null;

/**
 * Binds the session's tree reader, or unbinds it at sign-out. Either way every read so far is
 * forgotten: the trees belong to the account that read them.
 */
export function bindGroupTreeReader(next: GroupTreeReader | null): void {
  reader = next;
  membersByGroup.clear();
  latestRead.clear();
}

/** The user ids `groupId`'s tree held at the last read, or `undefined` when it was never read. */
export function groupTreeMemberIds(groupId: string): readonly string[] | undefined {
  return membersByGroup.get(groupId);
}

/**
 * Re-reads `groupId`'s tree and publishes who it holds when that changed. A group this device does
 * not hold (a newcomer before its Welcome, a follower tab) has no tree to read and is not asked to:
 * its label keeps the generic word, said at debug because it is an ordinary state and not a fault.
 */
export async function refreshGroupTreeMembers(groupId: string, why: string): Promise<void> {
  if (!reader || !groupId) return;
  const seq = ++readSeq;
  latestRead.set(groupId, seq);
  if (!reader.holds(groupId)) {
    // Asked, not learned by failing: no read is attempted. The group stays recorded as seen, so the
    // Welcome that installs it (`noteGroupTreeChanged`) reads it then.
    membersByGroup.delete(groupId);
    console.debug(
      `[GROUP_LABEL] ${groupId.slice(0, 8)}... tree not read after ${why} - this device does not hold it; the label stays generic`
    );
    return;
  }
  let identities: string[];
  try {
    identities = await reader.read(groupId);
  } catch (e) {
    if (latestRead.get(groupId) !== seq) return;
    // A HELD group that cannot be read is a fault (WASM not ready, a corrupt group), never an
    // ordinary state: said at warn, and NOT recorded as read so the next sight tries again.
    membersByGroup.delete(groupId);
    latestRead.delete(groupId);
    console.warn(
      `[GROUP_LABEL] ${groupId.slice(0, 8)}... tree of a held group could not be read after ${why}: ${String(e).slice(0, 120)}; the label stays generic until the next sight`
    );
    return;
  }
  if (latestRead.get(groupId) !== seq) return;
  const ids = memberUserIdsOfTree(identities);
  const held = membersByGroup.get(groupId);
  if (held && held.length === ids.length && held.every((id, i) => id === ids[i])) return;
  membersByGroup.set(groupId, ids);
  console.debug(
    `[GROUP_LABEL] ${groupId.slice(0, 8)}... ${ids.length} member(s) read after ${why}`
  );
  // The label names people by their FIRST name, a profile column: asked once per person here, so
  // the label fills in as profiles land (the first-name cache is reactive).
  for (const id of ids) {
    void resolveUserDisplayName(id).catch((err: unknown) =>
      console.warn(`[GROUP_LABEL] the name of a member could not be asked: ${String(err)}`)
    );
  }
}

/** Reads `groupId`'s tree once, when no read was ever asked for it - a group drawn before any commit. */
export function ensureGroupTreeMembers(groupId: string): void {
  if (!reader || latestRead.has(groupId)) return;
  void refreshGroupTreeMembers(groupId, 'first sight');
}

/**
 * A commit or a Welcome changed `groupId`'s tree on this device: read it again - when a label was
 * ever drawn for it. A group nothing labels (a named group, a community's key group) costs no read;
 * the first time one is drawn, {@link ensureGroupTreeMembers} reads it.
 */
export function noteGroupTreeChanged(groupId: string, why: string): void {
  if (!latestRead.has(groupId)) return;
  void refreshGroupTreeMembers(groupId, why);
}

/**
 * The label of the unnamed group `groupId` as `viewerId` sees it, or `null` while its tree has not
 * been read (or holds nobody else) - the caller then keeps the generic word. Asks for the first read
 * on sight, so the label appears without anybody having to open the group.
 *
 * Each member is named by their FIRST name, and a nickname set in this group replaces it, as it does
 * everywhere inside the group (`getUserFirstNameSync` with the group as its scope).
 */
export function unnamedGroupLabelOf(groupId: string, viewerId: string): string | null {
  const ids = membersByGroup.get(groupId);
  if (!ids) {
    ensureGroupTreeMembers(groupId);
    return null;
  }
  return composeUnnamedGroupLabel(ids, viewerId, (id) =>
    getUserFirstNameSync(id, getUserDisplayNameSync(id, undefined, groupId), groupId)
  );
}
