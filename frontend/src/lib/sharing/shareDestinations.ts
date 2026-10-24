/**
 * What a share destination is called, read the same way by the "Envoyer a..." picker
 * (`ForwardMessageModal`) and by the share sheet's suggestions (`shareTargets.ts`), so a
 * conversation suggested by Android carries the very name the picker then shows for it.
 * See `docs/wiki/frontend/sharing.md`.
 */
import {
  compareConversationRecency,
  resolveConversationListPresentation,
} from '$lib/utils/chat/conversations';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
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

/** One destination as a picker draws it. */
export interface ShareCandidate {
  /** The conversation map key (a DM is keyed by its display name). */
  key: string;
  conversation: Conversation;
  /** The human-readable name: the peer for a DM, the group or salon name otherwise. */
  label: string;
  /** The community's name when the destination is a salon, else null. */
  community: string | null;
}

/**
 * The destinations a picker lists, filtered by `query` (name or community) - read the same way by
 * the "Envoyer a..." picker (`ForwardMessageModal`, ordered `alphabetical`: a list to search) and by
 * a post's share sheet (`PostShareSheet`, ordered `recent`: the grid opens on whom the member talks
 * to, as Instagram's does). A row with no name yet is left out, never shown as a raw id.
 * `peerNames` carries the DM names fetched after the list was first built
 * (`missingPeerNameIds`).
 */
export function shareCandidates(input: {
  conversations: Iterable<[string, Conversation]>;
  currentUserId: string;
  workspaces: readonly WorkspaceLike[];
  peerNames: Readonly<Record<string, string>>;
  query: string;
  excludeKey?: string | null;
  order: 'alphabetical' | 'recent';
  /** Offered first whatever the order: the share-sheet suggestion the member picked (lot S5). */
  preselectedId?: string | null;
}): ShareCandidate[] {
  const communityOf = channelCommunities(input.workspaces);
  const q = input.query.trim().toLowerCase();
  const preselected = (c: ShareCandidate) =>
    input.preselectedId != null && c.conversation.id === input.preselectedId;
  return [...input.conversations]
    .filter(([key]) => key !== input.excludeKey)
    .map(([key, c]): ShareCandidate => {
      const pres = shareDestinationPresentation(c, input.currentUserId);
      const label = pres.displayNameResolved
        ? pres.displayName
        : (input.peerNames[pres.contactId] ?? pres.displayName);
      const community = isChannelConversationId(c.id) ? (communityOf.get(c.id) ?? null) : null;
      return { key, conversation: c, label, community };
    })
    .filter((cand) => cand.label.trim().length > 0)
    .filter(
      (cand) =>
        !q ||
        cand.label.toLowerCase().includes(q) ||
        (cand.community?.toLowerCase().includes(q) ?? false)
    )
    .sort(
      (a, b) =>
        Number(preselected(b)) - Number(preselected(a)) ||
        (input.order === 'recent'
          ? compareConversationRecency(a.conversation, b.conversation)
          : (a.community ?? '').localeCompare(b.community ?? '') || a.label.localeCompare(b.label))
    );
}

/**
 * The DM peers whose name the synchronous resolver does not know yet: a picker fetches them
 * (`resolveUserDisplayName`) so it never lists "Utilisateur inconnu" - and its search, which
 * filters on that label, can find the person.
 */
export function missingPeerNameIds(
  conversations: Iterable<[string, Conversation]>,
  currentUserId: string,
  excludeKey: string | null = null
): string[] {
  const ids: string[] = [];
  for (const [key, c] of conversations) {
    if (key === excludeKey) continue;
    const pres = shareDestinationPresentation(c, currentUserId);
    if (pres.displayNameResolved || pres.conversationType !== 'direct') continue;
    ids.push(pres.contactId);
  }
  return ids;
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
