/**
 * WHICH CONVERSATIONS A STORE WRITE CHANGED, said by the seam every write crosses - so a reader that
 * keeps something derived from the stored messages (the universal search's local message index,
 * `$lib/search/localMessageIndex.ts`) learns of a change from the write itself, never from a clock.
 *
 * WHY A TABLE AND NOT A GUESS FROM THE ARGUMENTS. Each `IStorage` method that changes a message row
 * is listed with the conversations its arguments name; a method that changes rows without naming
 * them (`clear`, `deleteOldMessages`, a reseal) answers `'all'`. Every other method is listed in
 * {@link NOT_A_MESSAGE_WRITE}, and `messageWrites.test.ts` reads the interface in `types.ts` and
 * fails on a method in neither list - so a new write path cannot be added silently.
 *
 * ONE REALM. On the web every tab of the account shares the IndexedDB, and this seam sees only the
 * writes of THIS tab; the index's page says what that bounds (`universal-search.md`).
 */
import type { IStorage, StoredMessage, EncryptedMessageRow } from './types';

/** The conversations a write touched, or every conversation. */
export type TouchedConversations = readonly string[] | 'all';

type ArgsOf = (args: readonly unknown[]) => TouchedConversations;

const firstArg: ArgsOf = (args) => [String(args[0])];
const oneMessage: ArgsOf = (args) => [(args[0] as StoredMessage).conversationId];
const manyMessages: ArgsOf = (args) => [
  ...new Set((args[0] as StoredMessage[]).map((msg) => msg.conversationId)),
];

/** Every `IStorage` method that changes a stored message row, and what it changed. */
export const MESSAGE_WRITES: Readonly<Record<string, ArgsOf>> = {
  saveMessage: oneMessage,
  saveMessages: manyMessages,
  saveMessagesIfAbsent: manyMessages,
  saveMessageWithOutboxEntry: oneMessage,
  updateMessage: firstArg,
  mergeMessages: firstArg,
  moveMessages: (args) => [String(args[0]), String(args[1])],
  deleteMessage: firstArg,
  deleteMessagesForConversation: firstArg,
  deleteConversation: firstArg,
  importEncryptedRow: (args) => [(args[0] as EncryptedMessageRow).conversationId],
  deleteOldMessages: () => 'all',
  swapSealedPayloads: () => 'all',
  clear: () => 'all',
};

/** Every other `IStorage` member: reads, and writes to stores that hold no message text. */
export const NOT_A_MESSAGE_WRITE: readonly string[] = [
  'init',
  'close',
  'isOpen',
  'saveConversation',
  'mergeConversation',
  'getConversations',
  'getConversation',
  'getMessage',
  'getMessageStanding',
  'findMessageConversations',
  'getMessagesByIds',
  'getMessages',
  'getMessagesSince',
  'getMessagesPage',
  'getMessageConversationIds',
  'countMessages',
  'messageStoreIncarnation',
  'getAllEncryptedRows',
  'putPendingMutation',
  'getPendingMutations',
  'getPendingMutationsOf',
  'deletePendingMutations',
  'resealPendingMutations',
  'saveOutboxEntry',
  'saveReelTake',
  'getOutboxQueue',
  'getReelTakeRecords',
  'getOutboxEntry',
  'getOutboxEntriesForConversation',
  'updateOutboxEntry',
  'deleteOutboxEntry',
  'sweepOutboxBlobs',
  'savePendingGroupExit',
  'getPendingGroupExits',
  'deletePendingGroupExit',
  'saveDistributionGroup',
  'getDistributionGroups',
  'deleteDistributionGroup',
  'saveGraineSession',
  'getGraineSessions',
  'getGraineSession',
  'getGraineSessionsForWorkspace',
  'countGraineSessionsForWorkspace',
  'deleteGraineSessionsForWorkspace',
  'deleteGraineSessions',
  'getAllEncryptedGraineRows',
  'importEncryptedGraineRow',
  'getSealedPayloads',
  'saveFeedPage',
  'getFeedPage',
  'deleteFeedPages',
  'deleteFeedPage',
];

type Listener = (touched: TouchedConversations) => void;
const listeners = new Set<Listener>();

/**
 * Calls `listener` after every message write that went through an observed store in this realm,
 * whether it succeeded or failed (a failed write may have written part of its rows). Returns the
 * unsubscribe.
 */
export function subscribeMessageWrites(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(method: string, touched: TouchedConversations): void {
  for (const listener of listeners) {
    // Isolation is a `try` per subscriber: one failing reader must not hide the write from another.
    try {
      listener(touched);
    } catch (e) {
      console.error(`[DB] a message-write listener failed after ${method}: ${String(e)}`);
    }
  }
}

/**
 * `storage`, with every call of a {@link MESSAGE_WRITES} method announced to the listeners once it
 * settles. Reads and other writes pass through untouched. Methods stay bound to the wrapped store.
 */
export function observeMessageWrites(storage: IStorage): IStorage {
  return new Proxy(storage, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof prop !== 'string' || typeof value !== 'function') return value;
      const touchedBy = MESSAGE_WRITES[prop];
      if (!touchedBy) return value.bind(target);
      const method = value as (...args: unknown[]) => Promise<unknown>;
      return async (...args: unknown[]) => {
        try {
          return await method.apply(target, args);
        } finally {
          announce(prop, touchedBy(args));
        }
      };
    },
  });
}
