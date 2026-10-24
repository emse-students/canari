/**
 * incomingShare - content another app shared INTO Canari, on its way to a conversation.
 *
 * A share is a DRAFT, never a send. It lives here from the moment the native layer hands it over
 * (`incomingShareDrain`) until the member has picked a destination and that conversation is on
 * screen: then the text goes into the composer and the files into its pending queue, and the
 * member sends with the ordinary Send button. Nothing in this store sends anything.
 *
 * Two steps, two fields:
 * 1. `pending` without a `target`: the "Envoyer a..." picker is shown (`IncomingShareHost`), once
 *    the session is up - the PIN comes first, and nothing here needs a clock to wait for it.
 * 2. `target` set: the picker published the conversation as a deep-link landing (`notifNav`), and
 *    the chat page takes the share with `takeFor` the moment that conversation is the one displayed.
 *
 * Memory only. A share that has not been taken when the app dies is lost with the page - the
 * member shares again - and a share never outlives the page that was shown it. A share DROPPED here
 * (replaced, cancelled, or erased at sign-out) has its copies deleted at once
 * (`discardSharedFiles`); one lost with the page is swept at the next process start
 * (`IncomingShare.sweepOrphansOnce`).
 */
import { appendLog } from '$lib/utils/sessionLog';
import { discardSharedFiles } from '$lib/mobile/sharedInbox';

/**
 * One shared file, still ON DISK where the native layer copied it. It is read only when the share
 * is staged in a conversation (`stageSharedFiles`), never before a destination is picked.
 */
export interface SharedFileEntry {
  path: string;
  name: string;
  mime: string;
  /** Its size in bytes, so a copy over the upload ceiling is refused without being read. */
  size: number;
}

/** What was shared: text (a link is text) and files, both possibly empty but never both. */
export interface IncomingSharePayload {
  text: string;
  files: SharedFileEntry[];
  /**
   * The conversation id the member picked among Android's share-sheet suggestions (lot S5), or
   * null. A HINT for the picker, which preselects it only when the signed-in account holds that
   * conversation - never a destination by itself: the member still confirms.
   */
  suggested?: string | null;
}

let pending = $state<IncomingSharePayload | null>(null);
let target = $state<string | null>(null);
/** The share epoch of the held share (0 outside the mobile apps, which have none). */
let pendingEpoch = 0;
/**
 * The epoch of the last sign-out this page saw (`fence`): an offer from an older epoch is refused.
 * It closes the race the erase alone leaves - a drain that claimed its manifest before the sign-out
 * and offers it after the store was emptied.
 */
let floor = 0;

export const incomingShare = {
  /** The share waiting for a destination or for its destination to be displayed. */
  get pending(): IncomingSharePayload | null {
    return pending;
  },
  /** The conversation id the member picked, or null while the picker is still to be answered. */
  get target(): string | null {
    return target;
  },
  /**
   * Offers a new share. It REPLACES one not yet taken: the member shared again, and only the latest
   * is what they mean. An empty share (no text, no file) is refused.
   */
  offer(payload: IncomingSharePayload, epoch = 0): boolean {
    const text = payload.text.trim();
    if (epoch < floor) {
      appendLog(`[SHARE] a share from before a sign-out (epoch ${epoch} < ${floor}) - deleted`);
      void discardSharedFiles(
        payload.files.map((f) => f.path),
        'offered after a sign-out'
      );
      return false;
    }
    if (!text && payload.files.length === 0) {
      appendLog('[SHARE] an empty share was not offered');
      return false;
    }
    if (pending) {
      appendLog('[SHARE] a share not yet taken was replaced by a newer one');
      void discardSharedFiles(
        pending.files.map((f) => f.path),
        'replaced by a newer share'
      );
    }
    const suggested = payload.suggested ?? null;
    appendLog(
      `[SHARE] offered: ${text.length} chars, ${payload.files.length} file(s), suggestion=${suggested !== null}`
    );
    pending = { text, files: payload.files, suggested };
    pendingEpoch = epoch;
    target = null;
    return true;
  },
  /**
   * A share made INSIDE Canari - a post's or a reel's link sent from its share sheet
   * (`posts/sharePost.ts`) - offered with its destination already picked, in one step, so the
   * "Envoyer a..." picker of `IncomingShareHost` never opens for it. It is a text and no file, and
   * it travels the same road as a share from another app: the landing, then the composer, then the
   * member's own Send.
   *
   * Its epoch is the FLOOR: it was made by the page now signed in, after every sign-out this page
   * has seen, so the fence cannot refuse it - and a sign-out still drops it (`drop`, called by
   * `eraseIncomingShare` before anything else).
   */
  offerTo(text: string, conversationId: string): boolean {
    if (!this.offer({ text, files: [] }, floor)) return false;
    this.chooseTarget(conversationId);
    return true;
  },
  /** Records the destination the member picked (a conversation id, as `notifNav` lands on). */
  chooseTarget(conversationId: string): void {
    if (!pending) return;
    appendLog(`[SHARE] destination chosen: ${conversationId.slice(0, 16)}`);
    target = conversationId;
  },
  /**
   * Hands the share over when `conversationId` is its destination, and ends it. Null otherwise -
   * including a second call, so a share is staged exactly once.
   */
  takeFor(conversationId: string): IncomingSharePayload | null {
    if (!pending || target !== conversationId) return null;
    const taken = pending;
    pending = null;
    target = null;
    appendLog(`[SHARE] taken by ${conversationId.slice(0, 16)}`);
    return taken;
  },
  /**
   * The landing on the chosen conversation ended before that conversation was displayed (it was
   * abandoned, or the member went elsewhere): the share asks for its destination again rather than
   * waiting for a conversation that will not open.
   */
  releaseTarget(): void {
    if (!pending || target === null) return;
    appendLog(
      `[SHARE] the landing on ${target.slice(0, 16)} ended before it was displayed - asking again`
    );
    target = null;
  },
  /** The member dismissed the picker: the share is dropped, and its copies deleted unread. */
  cancel(): void {
    this.drop('cancelled by the member');
  },
  /**
   * A sign-out advanced the share epoch to `epoch`: from now on an offer from an older one is
   * refused, and a held share from an older one is dropped. `Infinity` when the advance FAILED:
   * nothing is offered again in this process, since this session's shares and the last one's can no
   * longer be told apart.
   */
  fence(epoch: number, reason: string): void {
    floor = Math.max(floor, epoch);
    appendLog(`[SHARE] fenced at epoch ${floor} (${reason})`);
    if (pending && pendingEpoch < floor) this.drop(reason);
  },
  /**
   * Drops whatever share is held - waiting for its destination or for its destination to open -
   * and deletes its copies unread. The picker's dismissal (`cancel`), and a SIGN-OUT
   * (`eraseIncomingShare`): a share must never land in the account signed in next.
   */
  drop(reason: string): void {
    if (!pending) return;
    appendLog(`[SHARE] dropped: ${reason}`);
    void discardSharedFiles(
      pending.files.map((f) => f.path),
      reason
    );
    pending = null;
    target = null;
  },
};
