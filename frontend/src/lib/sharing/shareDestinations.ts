/**
 * What a share destination is called, read the same way by the "Envoyer a..." picker
 * (`ForwardMessageModal`) and by the share sheet's suggestions (`shareTargets.ts`), so a
 * conversation suggested by Android carries the very name the picker then shows for it.
 * See `docs/wiki/frontend/sharing.md`.
 */
import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
import type { Conversation } from '$lib/types';

/** Minimal community-workspace shape needed to resolve a channel's community. */
export interface WorkspaceLike {
  name: string;
  channels: { id: string }[];
}

/**
 * A destination's presentation: the peer for a DM, the group or salon name otherwise - never a raw
 * id. `displayNameResolved` is false for a DM whose peer's name is not known yet.
 */
export function shareDestinationPresentation(c: Conversation, currentUserId: string) {
  return resolveConversationListPresentation(
    {
      id: c.id,
      name: c.name,
      contactName: c.contactName ?? c.id,
      conversationType: c.conversationType,
      directPeerId: c.directPeerId,
    },
    currentUserId
  );
}

/**
 * Channel (salon) conversation id -> its community's name: several salons share a name ("General"),
 * and only the community tells them apart.
 */
export function channelCommunities(workspaces: readonly WorkspaceLike[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const ws of workspaces) {
    for (const ch of ws.channels) map.set(ch.id, ws.name);
  }
  return map;
}

/**
 * The conversation a share-sheet suggestion named (lot S5), ONLY if `conversations` - the signed-in
 * account's list - holds it; null otherwise. A shortcut published by an earlier account, or for a
 * conversation since left, must preselect nothing.
 */
export function suggestionIfHeld(
  suggested: string | null,
  conversations: Iterable<Pick<Conversation, 'id'>>
): string | null {
  if (suggested === null) return null;
  for (const c of conversations) if (c.id === suggested) return suggested;
  return null;
}
