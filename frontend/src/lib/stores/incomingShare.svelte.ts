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
 * member shares again - and a share never outlives the page that was shown it.
 */
import { appendLog } from '$lib/utils/sessionLog';

/**
 * One shared file, still ON DISK where the native layer copied it. It is read only when the share
 * is staged in a conversation (`readSharedFiles`), never before a destination is picked.
 */
export interface SharedFileEntry {
  path: string;
  name: string;
  mime: string;
}

/** What was shared: text (a link is text) and files, both possibly empty but never both. */
export interface IncomingSharePayload {
  text: string;
  files: SharedFileEntry[];
}

let pending = $state<IncomingSharePayload | null>(null);
let target = $state<string | null>(null);

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
  offer(payload: IncomingSharePayload): boolean {
    const text = payload.text.trim();
    if (!text && payload.files.length === 0) {
      appendLog('[SHARE] an empty share was not offered');
      return false;
    }
    if (pending) appendLog('[SHARE] a share not yet taken was replaced by a newer one');
    appendLog(`[SHARE] offered: ${text.length} chars, ${payload.files.length} file(s)`);
    pending = { text, files: payload.files };
    target = null;
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
  /** The member dismissed the picker: the share is dropped. */
  cancel(): void {
    if (!pending) return;
    appendLog('[SHARE] cancelled by the member');
    pending = null;
    target = null;
  },
};
