/**
 * WHICH CONVERSATIONS "ENVOYER A..." LISTS, AND HOW A TICK IS COUNTED (reels-in-chat RC-12, 15.8).
 * Pure: the sheet reads the live conversation map, this decides.
 *
 * THE LIST IS A COURTESY, THE SERVER THE AUTHORITY: a permission withdrawn between the sheet and
 * the send fails THAT send only (15.2). So the filter below only keeps out what the client already
 * KNOWS cannot be sent to, never what it would have to guess.
 */
import type { Conversation } from '$lib/types';
import { isNeverAdmitted } from '$lib/utils/chat/admissionState';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import { shareCandidates, type ShareCandidate } from '$lib/sharing/shareDestinations';

/**
 * Whether the sheet lists `c`: a DM or a group the member belongs to. NOT listed: a salon (RC-8 has
 * not shipped, D-salons-later: the camera films in no salon today), a conversation the member left
 * (`removed`), a pending invitation or message request (`awaitingAdmission` on a `pending` row), and a
 * DM with a person the member blocked. A group that is merely not ready yet queues like any message.
 */
export function isReelSendListed(c: Conversation, blockedPeerIds: ReadonlySet<string>): boolean {
  if (c.conversationType === 'channel' || isChannelConversationId(c.id)) return false;
  if (c.lifecycle === 'removed' || isNeverAdmitted(c)) return false;
  if (c.conversationType === 'direct' && c.directPeerId && blockedPeerIds.has(c.directPeerId)) {
    return false;
  }
  return true;
}

/**
 * The rows under "Publier sur CanaReels": the conversation list's own order (last activity first),
 * filtered locally on the conversation name or the DM peer's display name - no server search.
 */
export function reelSendCandidates(input: {
  conversations: Iterable<[string, Conversation]>;
  currentUserId: string;
  /** DM names fetched after the list was first built (`missingPeerNameIds`). */
  peerNames: Readonly<Record<string, string>>;
  query: string;
  blockedPeerIds: ReadonlySet<string>;
}): ShareCandidate[] {
  const listed = [...input.conversations].filter(([, c]) =>
    isReelSendListed(c, input.blockedPeerIds)
  );
  return shareCandidates({
    conversations: listed,
    currentUserId: input.currentUserId,
    workspaces: [],
    peerNames: input.peerNames,
    query: input.query,
    order: 'recent',
  });
}

/** The result of a tick: the new selection, and whether the cap REFUSED it (said, never silent). */
export interface TargetToggle {
  selected: string[];
  capped: boolean;
}

/**
 * Ticks or unticks `key`. A tick past `cap` is refused with `capped: true` - the sheet says a
 * sentence - and an untick is always allowed.
 */
export function toggleReelTarget(
  selected: readonly string[],
  key: string,
  cap: number
): TargetToggle {
  if (selected.includes(key)) return { selected: selected.filter((k) => k !== key), capped: false };
  if (selected.length >= cap) return { selected: [...selected], capped: true };
  return { selected: [...selected, key], capped: false };
}

/** What the sheet's one press does, from what is ticked: nothing, publish alone, chats alone, or both. */
export type ReelSendPlan = 'none' | 'feed' | 'chats' | 'both';

/** The plan for a selection - "feed alone" is today's path byte for byte, so it is its own case. */
export function reelSendPlan(feedTicked: boolean, chatCount: number): ReelSendPlan {
  if (chatCount > 0) return feedTicked ? 'both' : 'chats';
  return feedTicked ? 'feed' : 'none';
}
