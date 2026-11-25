import type { IStorage, StoredMessage } from '$lib/db';
import { canonicalUserId } from '$lib/mls-client/leafIdentity';

/**
 * THIS ACCOUNT'S OWN STORED ROW UNDER `messageId`, for a caller that knows only an id it minted (a
 * quick reply's, an own bubble's) and not the conversation it went to.
 *
 * A stored message is keyed by `(conversationId, id)`, and the id is chosen by the frame that carries
 * it: another conversation may hold a row under the same id, written by somebody else. So every
 * conversation holding the id is asked (`findMessageConversations`, an index read), each row is read
 * by its key, and only a row THIS ACCOUNT authored is answered - never the first one found. `null`
 * when none is stored or none is this account's.
 */
export async function ownStoredMessage(
  storage: IStorage,
  messageId: string,
  userId: string,
  deviceKeyB64: string
): Promise<StoredMessage | null> {
  const me = canonicalUserId(userId);
  const holders = await storage.findMessageConversations(messageId);
  for (const conversationId of holders) {
    const row = await storage.getMessage(conversationId, messageId, deviceKeyB64);
    if (row && canonicalUserId(row.senderId) === me) return row;
  }
  if (holders.length > 0) {
    console.debug(
      `[DB] ${messageId.slice(0, 8)}... is stored in ${holders.length} conversation(s), none of them as this account's own row`
    );
  }
  return null;
}
