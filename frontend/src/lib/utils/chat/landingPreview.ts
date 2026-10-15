/**
 * The notification landing's LOCAL PREVIEW: the target conversation read from this device's store
 * while the session is still being verified (F1, approved by the user 2026-10-12).
 *
 * A tap on a message notification names a conversation long before the session is up - on the
 * Mi 9T the deep link is parsed ~1.3 s after the tap and `MLS ready` lands ~0.9 s later on the
 * vault path, during which the token refresh and the revocation question are in flight. Everything
 * needed to DRAW the conversation is already on the device: its row and its newest stored page,
 * sealed under the device key the vault just returned. This module reads exactly that and nothing
 * else.
 *
 * WHAT IT MAY NOT DO IS THE WHOLE CONTRACT, because it runs before the server has said this device
 * is still allowed to exist:
 *  - no network: the display-name resolution the restore runs (`retroactivelyResolveHexIds`) is
 *    skipped on purpose, it asks the directory;
 *  - no write: nothing is saved, so a revoked device's wipe has nothing new to erase;
 *  - no MLS: the conversation is read, never opened as a group.
 * The caller owns the rest: the preview is discarded if the login fails, and the revocation wipe
 * waits for it before erasing (`loginImpl`).
 *
 * A community salon has no preview: the store holds only a copy of its last page (F4), drawn when
 * the salon is opened in a session, and a landing before the session is not that.
 */
import type { IStorage } from '$lib/db';
import type { ChatMessage, Conversation } from '$lib/types';
import { isChannelConversationId } from './channelCrypto';
import { INITIAL_MESSAGES_PAGE, restoredConversationRow } from './conversations';
import { mapStoredMessagesToChatMessages } from './history';

/** What the local store gave for a landing target, ready to be put in the conversations map. */
export interface LandingPreview {
  row: Conversation;
  /** Number of stored messages drawn, for the log line. */
  messageCount: number;
}

/** Why the store gave nothing - each one is a line in the log, none of them is an error. */
export type LandingPreviewSkip = 'channel' | 'not-stored';

/**
 * Reads the landing target's row and newest stored page from the local store.
 *
 * @param targetId the MLS group id the notification named (the map key a restored row uses)
 * @returns the row with its page, or why there is none
 */
export async function readLandingPreview(input: {
  storage: IStorage;
  deviceKeyB64: string;
  userId: string;
  targetId: string;
}): Promise<LandingPreview | LandingPreviewSkip> {
  if (isChannelConversationId(input.targetId)) return 'channel';
  const meta = await input.storage.getConversation(input.targetId);
  if (!meta) return 'not-stored';
  const stored = await input.storage.getMessagesPage(
    input.targetId,
    input.deviceKeyB64,
    INITIAL_MESSAGES_PAGE
  );
  const messages: ChatMessage[] = mapStoredMessagesToChatMessages(stored, input.userId);
  return {
    row: { ...restoredConversationRow(meta, input.userId), messages },
    messageCount: messages.length,
  };
}
