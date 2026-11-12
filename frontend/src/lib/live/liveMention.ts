/**
 * THE MENTIONS OF A LIVE CHAT, CLIENT SIDE (owner, 2026-11-09; docs/wiki/services/lives.md "Mentions
 * in the live chat"). Three pure pieces around the shared `@[id]` token (`$lib/utils/mentions`) - the
 * parser, the picker and the chip are the ones every other surface uses:
 *
 * - {@link liveMentionRoster}: who the `@` picker suggests FIRST - the people the chat shows;
 * - {@link liveAudienceFilter}: who it may suggest AFTER them (the server's audience, never a guess);
 * - {@link mentionsViewer}: whether a line is highlighted for the signed-in viewer.
 *
 * A live has no list of who is watching on purpose (the server serves viewer ids to nobody), so "the
 * people here" is the people the chat has shown: whoever wrote, whoever the broadcaster was told
 * arrived, and the broadcaster.
 */
import { extractMentionUserIds, normalizeMentionUserId } from '$lib/utils/mentions';
import type { MentionUser } from '$lib/composables/useMentionAutocomplete.svelte';
import type { MentionRosterMember } from '$lib/utils/users/mentionRoster';
import type { LiveChatLine } from './liveChat';

/**
 * The accounts the chat has shown, most recent first (`lastSpokeAt` is the line's position, so the
 * picker's recency order is the chat's), the broadcaster last when nobody has spoken. The viewer is
 * left to the picker, which never offers the signed-in account.
 */
export function liveMentionRoster(
  lines: readonly LiveChatLine[],
  hostId: string | null
): MentionRosterMember[] {
  const at = new Map<string, number>();
  lines.forEach((line, index) => {
    if (!line.authorId || line.kind === 'arrivals-more') return;
    at.set(normalizeMentionUserId(line.authorId), index + 1);
  });
  if (hostId) {
    const host = normalizeMentionUserId(hostId);
    if (!at.has(host)) at.set(host, 0);
  }
  return [...at.entries()].map(([id, lastSpokeAt]) => ({ id, lastSpokeAt }));
}

/**
 * The picker's filter for a NAME SEARCH: the accounts the directory found, narrowed to those the live
 * lets a mention reach (`audienceOf` is the server's `mention-audience`). A failed ask offers
 * NOBODY from the directory - never an unfiltered list - and says so; the roster rows stay.
 */
export function liveAudienceFilter(
  audienceOf: (ids: string[]) => Promise<string[]>
): (users: MentionUser[]) => Promise<MentionUser[]> {
  // ONE WARNING PER OUTAGE, not one per key typed while the audience cannot be read: the next
  // answer re-arms it (review of #3402).
  let failing = false;
  return async (users) => {
    if (users.length === 0) return [];
    try {
      const allowed = new Set(
        (await audienceOf(users.map((u) => u.id))).map((id) => id.toLowerCase())
      );
      failing = false;
      return users.filter((u) => allowed.has(u.id.toLowerCase()));
    } catch (e) {
      if (!failing)
        console.warn('[LIVE_CHAT] the audience of a mention search could not be read', e);
      else console.debug('[LIVE_CHAT] the audience of a mention search still cannot be read');
      failing = true;
      return [];
    }
  };
}

/** Whether the text mentions `viewerId` - the line is then drawn highlighted for them. */
export function mentionsViewer(text: string, viewerId: string | null): boolean {
  if (!viewerId || !text.includes('@[')) return false;
  return extractMentionUserIds(text).includes(normalizeMentionUserId(viewerId));
}
