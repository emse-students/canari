/**
 * THE FACT THAT A CONVERSATION ROW WAS WRITTEN, announced where every writer ends up - SQLite's
 * `saveConversation` and `mergeConversation`, the store the native mirror runs beside (the web's
 * IndexedDB has no mirror, so no listener) - so what waits for a row acts the moment it exists
 * instead of at some later, unrelated pass.
 *
 * Today's one listener is the outbox: a native mirror line naming a conversation not yet stored is
 * left native (`adoptOrphanedMirrorEntries`), and is adopted when its row is written - by a
 * Welcome, a discovery, a restore - rather than at the next return to the front (review of #3969).
 */
import { appendLog } from '$lib/utils/sessionLog';

type Listener = (conversationId: string) => void;

const listeners = new Set<Listener>();

/** Registers `listener` for every conversation row written; returns its removal. */
export function onConversationStored(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Tells every listener the row of `conversationId` was written. A listener that throws costs only
 * itself, and says so: the write it follows has already succeeded.
 */
export function announceConversationStored(conversationId: string): void {
  for (const listener of listeners) {
    try {
      listener(conversationId);
    } catch (e) {
      appendLog(
        `[DB] a listener of the row of ${conversationId.slice(0, 8)}… threw - the row is written, that listener missed it: ${String(e)}`
      );
    }
  }
}
