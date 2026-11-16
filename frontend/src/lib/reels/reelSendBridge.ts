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
  /** The publish step's upload, adopted by the take waiting for it (15.5). */
  adopt: (takeId: string, uploaded: PublishedReelUpload) => Promise<void>;
  /** The publish step ended: the take stops waiting for it. */
  endWait: (takeId: string) => void;
  /**
   * The user ids in group `conversationId`, read from this device's LOCAL MLS tree (no server call):
   * the sheet names a few of them under the group's row. Throws when the group is not held here.
   */
  groupMemberIds: (conversationId: string) => Promise<string[]>;
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
