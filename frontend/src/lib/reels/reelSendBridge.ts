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
  /** The publish step's upload, adopted by the take waiting for it (15.5). */
  adopt: (takeId: string, uploaded: PublishedReelUpload) => Promise<void>;
  /** The publish step ended: the take stops waiting for it. */
  endWait: (takeId: string) => void;
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
