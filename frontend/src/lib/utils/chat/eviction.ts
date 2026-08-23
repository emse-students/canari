/**
 * Eviction policy: what the client does once a Remove commit naming this device has been applied.
 *
 * The rule is that the REMOVE COMMIT IS AUTHORITATIVE. It is a signed, ordered statement by a
 * member with the right to make it, and it is the same statement every other member applies - so
 * there is nothing to confirm, nothing to retry and nothing to repair. The conversation is retired
 * exactly as a peer-side deletion retires it, and `requestReAdd` is reserved for what it was
 * written for: a group this device believes it is IN but cannot use (an epoch fork, a lost
 * Welcome). Eviction is not a broken state, it is a correct one we are not part of.
 *
 * The fact is read from OpenMLS (`isGroupActive`), never mirrored into a flag of our own: the group
 * state is already durable, and a second copy can only ever be wrong in the direction that matters
 * - saying we are still a member of a group we were removed from.
 */

import type { IMlsService } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { markConversationDeletedRemotely } from '$lib/utils/chat/conversations';

/** Everything {@link retireIfEvicted} needs, kept to the narrowest set both call sites can supply. */
export interface EvictionCheckDeps {
  mlsService: Pick<IMlsService, 'isGroupActive'>;
  conversations: Map<string, Conversation>;
  groupId: string;
  userId: string;
  saveConversation: (key: string) => Promise<void>;
  log: (message: string) => void;
}

/**
 * Retires the conversation if this device is no longer a member of the group.
 *
 * Returns true when this call performed the transition, false when the device is still a member,
 * the conversation was already retired, or membership could not be read. Idempotent: the retire
 * itself is a no-op on a conversation already in `removed`, so a replayed commit costs one query.
 *
 * A failure to READ membership is deliberately not treated as an eviction. The two are opposite
 * facts and only one of them retires a conversation; an unheld group throws here, and answering
 * "evicted" to that would retire conversations this device simply had not loaded yet.
 */
export async function retireIfEvicted(deps: EvictionCheckDeps): Promise<boolean> {
  const { mlsService, conversations, groupId, userId, saveConversation, log } = deps;
  let active: boolean;
  try {
    active = await mlsService.isGroupActive(groupId);
  } catch (e) {
    // Swallowed because a membership query is not the point of the path it runs on - but never
    // silently: this is the branch that would hide an eviction, and the send-path backstop in the
    // outbox is what would then find it, one refused message later.
    log(
      `[EVICT] Membership of ${groupId.slice(0, 8)}… could not be read after a commit: ${String(e)}`
    );
    return false;
  }
  if (active) return false;

  const retired = markConversationDeletedRemotely(conversations, groupId, userId, saveConversation);
  log(
    retired
      ? `[EVICT] Removed from ${groupId.slice(0, 8)}… by a Remove commit - conversation retired`
      : `[EVICT] Removed from ${groupId.slice(0, 8)}… - already retired, nothing to do`
  );
  return retired;
}
