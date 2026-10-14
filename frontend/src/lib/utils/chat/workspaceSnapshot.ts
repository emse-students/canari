import type {
  ChannelSidebarItem,
  ChannelSidebarWorkspace,
} from '$lib/composables/useChannelWorkspaces.svelte';

/**
 * THE LAST COMMUNITY LIST THIS ACCOUNT WAS SHOWN, KEPT ON THE DEVICE SO THE NEXT LAUNCH DRAWS IT
 * BEFORE THE NETWORK (F1 of community-open-budget, 2026-10-14).
 *
 * WHY IT EXISTS. The rail and the salon rows were a NETWORK ANSWER: `channelWorkspaces` was filled
 * only by the workspace listing, which waited for the session, then for MLS, then for one listing
 * and one key-group check per community. Measured on the Mi 9T: the salons of the last community
 * 1.7 s after the tap on Wi-Fi, 6.0 s on a slow link with a 4x slower renderer, and NEVER offline
 * (3/3, and the user's Pixel 6a on production). The hub itself renders in ~150 ms once its data is
 * in memory, so the tab was a data problem, not a render problem.
 *
 * WHAT IT IS. A copy of what the last listing drew - communities in rail order, their image ids,
 * the salon rows with name, private, access and write - under ONE key per account
 * (`canari_workspace_snapshot:v1:<userId>`), read SYNCHRONOUSLY at module load so no `await` of
 * SQLite, the session or MLS stands in front of the first frame.
 *
 * WHAT IT IS NOT. Never an authority. The listing stays the only source of truth and replaces this
 * copy through the same upsert-and-prune path as before, so a community the member has lost since
 * disappears the moment the server says so, and the copy is rewritten from the answer.
 *
 * WHAT IS LEFT OUT, DELIBERATELY:
 * - the unread counts: the server's to say after every load (`salonUnread.ts`), and a stale badge
 *   is a lie about messages;
 * - the server's verdicts on the member (`viewerCanManage`, `viewerCanModerate`,
 *   `viewerCanManageChannels`): they default to "no" until the listing confirms them, and a copy
 *   would offer admin controls on the strength of a role the member may have lost;
 * - the history rule (`historyVisibility`): it feeds the seed layer, and the seed layer must read it
 *   from the same server answer as the sidebar, never from a copy.
 *
 * WHO MAY READ IT. Only the account it names: the key carries the id AND the payload repeats it, so
 * a slot read for another account is refused even if it was copied under the wrong name. Every slot
 * is erased by a sign-out and by a change of account (`stores/user.ts`), like the feed verdict.
 */

const KEY_PREFIX = 'canari_workspace_snapshot:v1:';

/** One salon row as stored - the fields the hub draws, and nothing the server must re-decide. */
interface StoredSalon {
  id: string;
  name: string;
  isPrivate?: boolean;
  hasAccess?: boolean;
  canWrite?: boolean;
}

/** One community as stored. */
interface StoredCommunity {
  id: string;
  name: string;
  workspaceDbId: string;
  avatarUserId: string;
  imageMediaId: string | null;
  channels: StoredSalon[];
}

/** The stored document: whose it is, and the communities in rail order. */
interface StoredSnapshot {
  owner: string;
  communities: StoredCommunity[];
}

/** The key one account's snapshot lives under. */
function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}`;
}

/** The salon fields worth a copy, read off a sidebar row. */
function storedSalon(channel: ChannelSidebarItem): StoredSalon {
  const salon: StoredSalon = { id: channel.id, name: channel.name };
  if (channel.isPrivate !== undefined) salon.isPrivate = channel.isPrivate;
  if (channel.hasAccess !== undefined) salon.hasAccess = channel.hasAccess;
  if (channel.canWrite !== undefined) salon.canWrite = channel.canWrite;
  return salon;
}

/**
 * The text a snapshot of `workspaces` would be stored as, for `owner`.
 *
 * A community the server has not named yet (no `workspaceDbId`) is left out: no listing can confirm
 * or prune it, so a copy of it could outlive its own failure.
 */
export function serializeWorkspaceSnapshot(
  owner: string,
  workspaces: readonly ChannelSidebarWorkspace[]
): string {
  const communities: StoredCommunity[] = [];
  for (const ws of workspaces) {
    if (!ws.workspaceDbId) continue;
    communities.push({
      id: ws.id,
      name: ws.name,
      workspaceDbId: ws.workspaceDbId,
      avatarUserId: ws.avatarUserId,
      imageMediaId: ws.imageMediaId ?? null,
      channels: ws.channels.map(storedSalon),
    });
  }
  const snapshot: StoredSnapshot = { owner, communities };
  return JSON.stringify(snapshot);
}

/** Writes an already-serialized snapshot. Never throws: a full or blocked store is logged. */
export function storeWorkspaceSnapshot(owner: string, text: string): void {
  try {
    localStorage.setItem(keyFor(owner), text);
  } catch (error) {
    console.warn(
      `[WORKSPACE-SNAPSHOT] could not save the community list (${String(error)}) - the next launch waits for the listing`
    );
  }
}

/** True when `value` has the shape of one stored salon. */
function isStoredSalon(value: unknown): value is StoredSalon {
  if (!value || typeof value !== 'object') return false;
  const salon = value as Record<string, unknown>;
  return (
    typeof salon.id === 'string' &&
    salon.id.startsWith('channel_') &&
    typeof salon.name === 'string' &&
    (salon.isPrivate === undefined || typeof salon.isPrivate === 'boolean') &&
    (salon.hasAccess === undefined || typeof salon.hasAccess === 'boolean') &&
    (salon.canWrite === undefined || typeof salon.canWrite === 'boolean')
  );
}

/** True when `value` has the shape of one stored community. */
function isStoredCommunity(value: unknown): value is StoredCommunity {
  if (!value || typeof value !== 'object') return false;
  const ws = value as Record<string, unknown>;
  return (
    typeof ws.id === 'string' &&
    typeof ws.name === 'string' &&
    typeof ws.workspaceDbId === 'string' &&
    typeof ws.avatarUserId === 'string' &&
    (ws.imageMediaId === null || typeof ws.imageMediaId === 'string') &&
    Array.isArray(ws.channels) &&
    ws.channels.every(isStoredSalon)
  );
}

/**
 * The community list last drawn for `userId`, as sidebar rows, or `null` when there is none.
 *
 * A slot that does not parse, does not have the stored shape, or names another account is not a
 * list: it is DELETED and said out loud, never half-drawn. The next listing writes a good one.
 */
export function readWorkspaceSnapshot(userId: string): ChannelSidebarWorkspace[] | null {
  let text: string | null;
  try {
    text = localStorage.getItem(keyFor(userId));
  } catch (error) {
    console.warn(
      `[WORKSPACE-SNAPSHOT] the saved community list could not be read: ${String(error)}`
    );
    return null;
  }
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const snapshot = parsed as Partial<StoredSnapshot> | null;
  const valid =
    snapshot !== null &&
    typeof snapshot === 'object' &&
    snapshot.owner === userId &&
    Array.isArray(snapshot.communities) &&
    snapshot.communities.every(isStoredCommunity);
  if (!valid) {
    console.warn(
      '[WORKSPACE-SNAPSHOT] the saved community list is not one this build wrote for this account - deleted, the listing draws the communities'
    );
    removeSlot(keyFor(userId));
    return null;
  }

  return snapshot.communities!.map((ws) => ({
    id: ws.id,
    name: ws.name,
    workspaceDbId: ws.workspaceDbId,
    avatarUserId: ws.avatarUserId,
    imageMediaId: ws.imageMediaId,
    channels: ws.channels.map((salon) => ({ ...salon })),
  }));
}

/** Removes one slot, logging a refusal rather than throwing. */
function removeSlot(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch (error) {
    console.warn(`[WORKSPACE-SNAPSHOT] could not delete ${key}: ${String(error)}`);
  }
}

/**
 * Erases EVERY account's saved community list.
 *
 * Called by a sign-out and by a change of account (`stores/user.ts`). The allowlist is this module's
 * own key prefix: nothing else in storage is touched. Every slot goes, not only the leaving
 * account's, because after a sign-out no account is signed in on this device and no list may wait
 * here for one.
 *
 * @returns how many slots were erased, for the caller's log.
 */
export function clearWorkspaceSnapshots(): number {
  let keys: string[];
  try {
    keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(KEY_PREFIX)) keys.push(key);
    }
  } catch (error) {
    console.warn(`[WORKSPACE-SNAPSHOT] could not list the saved community lists: ${String(error)}`);
    return 0;
  }
  for (const key of keys) removeSlot(key);
  if (keys.length > 0) {
    console.log(`[WORKSPACE-SNAPSHOT] ${keys.length} saved community list(s) erased`);
  }
  return keys.length;
}
