/**
 * HOW THE CAMERA TAB REACHES THE MESSAGING LAYER (reels-in-chat RC-12).
 *
 * The conversations, the account and the outbox live in the layout's `ChatBackgroundService`, which
 * lasts the whole session - the camera tab is a route of its own and holds none of them. The service
 * registers a HOST here; the tab reads it when the member opens "Envoyer a...". What the registry
 * buys is the NO-SESSION case: with no host the tab says the send is not ready and never sends into
 * a void. It does NOT isolate the import graph - the capture screen already reaches the chat
 * singleton, the outbox and the MLS engine through the publish step's pickers; it only avoids ADDING
 * a direct dependency of the sheet and the publish step on the outbox's adopt calls.
 */
import type { Conversation } from '$lib/types';
import type { PublishedReelUpload } from '$lib/reels/publishReel';
import type { ReelTakeAdoption } from '$lib/utils/chat/outbox';
import { parseDeviceIdentity } from '$lib/mls-client/commitAdmits';

/** What queuing a take answers: the take and how many sends were written. */
export interface QueuedReelTake {
  takeId: string;
  queued: number;
}

/** Options of {@link ReelSendHost.send}: a take ALSO published on CanaReels waits for that upload. */
export interface ReelTakeOptions {
  takeId?: string;
  awaitsPublish?: boolean;
}

/** The messaging layer, as the camera tab needs it. */
export interface ReelSendHost {
  /** The member's conversations by key - read inside a reactive scope, it tracks the live map. */
  conversations: () => Iterable<[string, Conversation]>;
  /** The signed-in account. */
  userId: () => string;
  /** Queues `file` as one take with one send per conversation key; `null` when nothing was written. */
  send: (
    file: File,
    targetKeys: readonly string[],
    opts: ReelTakeOptions
  ) => Promise<QueuedReelTake | null>;
  /**
   * Sends a PHOTO to each conversation key as an ordinary image message (D-photo); how many it was
   * handed to, `null` when none.
   */
  sendImage: (file: File, targetKeys: readonly string[]) => Promise<number | null>;
  /** The publish step's upload, adopted by the take waiting for it (15.5): what it did. */
  adopt: (takeId: string, uploaded: PublishedReelUpload) => Promise<ReelTakeAdoption>;
  /** The publish step ended: the take stops waiting for it. */
  endWait: (takeId: string) => void;
  /**
   * The user ids of each group in `conversationIds`, read from this device's LOCAL MLS trees (no
   * server call) ONCE MLS IS READY - one batch, so a sheet opened before the login finished asks
   * nothing until it can be answered ({@link readGroupMembersOnceReady}). A group missing from the
   * answer has no tree here; the sheet names a few members under each group's row. Never rejects.
   */
  groupMembers: (conversationIds: readonly string[]) => Promise<ReadonlyMap<string, string[]>>;
}

let host: ReelSendHost | null = null;

/** Registers the host; returns the function that withdraws it (the service's teardown). */
export function registerReelSendHost(next: ReelSendHost): () => void {
  host = next;
  return () => {
    if (host === next) host = null;
  };
}

/** The live host, or `null` when no session is up. */
export function reelSendHost(): ReelSendHost | null {
  return host;
}

/**
 * The distinct user ids of a tree's `userId:deviceId` leaves, in tree order (a member with two devices
 * is named once); a leaf that is not such an identity is skipped and said.
 */
export function userIdsOfIdentities(identities: readonly string[]): string[] {
  const ids: string[] = [];
  for (const entry of identities) {
    const parsed = parseDeviceIdentity(entry);
    if (!parsed) {
      console.warn('[reel-send] a tree leaf is not a userId:deviceId identity - skipped');
      continue;
    }
    if (!ids.includes(parsed.userId)) ids.push(parsed.userId);
  }
  return ids;
}

/**
 * The member user ids of each of `groupIds`, read in ONE BATCH once MLS is ready (`whenReady`, the
 * session's `whenMlsReady`): a sheet opened while the login is still running waits for the answer
 * rather than asking each tree, failing, and saying so per group. A session that ends first answers
 * an empty map with one debug line. A group whose tree this device does not hold is left out, and
 * every such group of the batch is said in ONE warn line (an `active` group with no tree is a fact
 * worth seeing, once). Never rejects.
 */
export async function readGroupMembersOnceReady(
  groupIds: readonly string[],
  deps: { whenReady: () => Promise<void>; readTree: (groupId: string) => Promise<string[]> }
): Promise<Map<string, string[]>> {
  const members = new Map<string, string[]>();
  if (groupIds.length === 0) return members;
  try {
    await deps.whenReady();
  } catch (e) {
    console.debug(
      `[reel-send] the session ended before MLS was ready: ${groupIds.length} group(s) shown without members`,
      e
    );
    return members;
  }
  let unreadable = 0;
  let firstError: unknown = null;
  for (const id of groupIds) {
    try {
      members.set(id, userIdsOfIdentities(await deps.readTree(id)));
    } catch (e) {
      unreadable += 1;
      firstError ??= e;
    }
  }
  if (unreadable > 0) {
    console.warn(
      `[reel-send] ${unreadable} of ${groupIds.length} active group(s) have no readable tree on this device - shown without members`,
      firstError
    );
  }
  return members;
}
