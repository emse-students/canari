import type { CallParticipant } from '$lib/services/CallService';
import type { Conversation } from '$lib/types';
import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';

/** What {@link resolveCallPeers} needs to know, passed in so it stays a pure function. */
export interface CallPeersInput {
  /** The signed-in user, any case. */
  userId: string;
  /** The conversation the CALL belongs to (`CallService.currentGroupId`). */
  callGroupId: string | null;
  /** Every conversation this device holds. */
  conversations: Iterable<Conversation>;
  /** Who rang us, when we are the callee. */
  incomingCallerId: string | null;
  /** A display name for a user id. */
  nameOf: (userId: string) => string;
}

/**
 * Who is on the other end of the call - read from the CALL's conversation, never from the one on
 * screen.
 *
 * It used to read `globalConvs.currentConvo`, which was right only while the call stayed in front of
 * the conversation it was placed from. Once a call can be minimised to the top banner and the app
 * browsed under it, the conversation on screen is any conversation: the banner would have named
 * whoever was open, and the avatar changed with every tap in the list. Calls are 1:1 (lot 1), so a
 * direct conversation names its peer; anything else falls to the caller we were rung by, or nobody.
 */
export function resolveCallPeers(input: CallPeersInput): CallParticipant[] {
  const uid = input.userId.toLowerCase();
  const callerId = input.incomingCallerId?.toLowerCase() ?? null;
  let convo: Conversation | undefined;
  if (input.callGroupId) {
    for (const c of input.conversations) {
      if (c.id === input.callGroupId) {
        convo = c;
        break;
      }
    }
  }
  if (convo) {
    const pres = resolveConversationListPresentation(
      {
        id: convo.id,
        name: convo.name,
        contactName: convo.contactName,
        conversationType: convo.conversationType,
        directPeerId: convo.directPeerId,
      },
      uid
    );
    if (pres.conversationType === 'direct') {
      const peer = pres.contactId.toLowerCase();
      if (peer && peer !== uid) return [{ userId: peer, displayName: pres.displayName }];
    }
  }
  if (callerId && callerId !== uid) {
    return [{ userId: callerId, displayName: input.nameOf(callerId) }];
  }
  return [];
}
