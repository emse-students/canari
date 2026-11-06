import { foldForSearch } from '$lib/utils/textFold';
import type { ChatMessage } from '$lib/types';

/** One member of the conversation a mention picker is open in. */
export interface MentionRosterMember {
  id: string;
  /** The name when the caller already holds it; the picker falls back to the display-name cache. */
  displayName?: string | null;
  /** Epoch ms of the member's latest message in THIS conversation, when one is loaded. */
  lastSpokeAt?: number;
}

/** How many rows a picker shows at once. */
export const MENTION_MAX_ROWS = 6;

/**
 * Builds a conversation's mention roster: its member ids, each stamped with the time the member
 * last spoke in the messages that are loaded. System rows carry no information about who is worth
 * suggesting, so they are skipped.
 */
export function buildMentionRoster(
  memberIds: readonly string[],
  messages: readonly Pick<ChatMessage, 'senderId' | 'timestamp' | 'isSystem'>[]
): MentionRosterMember[] {
  const last = new Map<string, number>();
  for (const msg of messages) {
    if (msg.isSystem) continue;
    const id = msg.senderId.toLowerCase();
    const at = new Date(msg.timestamp).getTime();
    if (Number.isFinite(at) && at > (last.get(id) ?? 0)) last.set(id, at);
  }
  return memberIds.map((id) => ({ id, lastSpokeAt: last.get(id.toLowerCase()) }));
}

/**
 * Picks the rows a roster-backed mention picker shows for `query`, locally.
 *
 * A word of the name must START with the folded query (accent- and case-insensitive), so "@m"
 * finds "Marie Dupont" and "Jean Martin" and a bare "@" finds everybody. Order: whoever spoke most
 * recently here first, then alphabetical on the folded name. `resolveName` supplies the name of a
 * member that carries none; a member with no name at all is left out, because a row that can only
 * read as a raw id is not one a reader can pick by typing.
 *
 * @param excludeIds - ids never offered (the signed-in reader, accounts they blocked)
 */
export function suggestFromRoster(
  roster: readonly MentionRosterMember[],
  query: string,
  {
    excludeIds,
    resolveName,
  }: { excludeIds: readonly string[]; resolveName: (id: string) => string | null }
): { id: string; displayName: string }[] {
  const excluded = new Set(excludeIds.map((id) => id.toLowerCase()));
  const q = foldForSearch(query.trim());
  const rows: { id: string; displayName: string; folded: string; at: number }[] = [];
  const seen = new Set<string>();
  for (const member of roster) {
    const key = member.id.toLowerCase();
    if (excluded.has(key) || seen.has(key)) continue;
    const name = member.displayName?.trim() || resolveName(member.id);
    if (!name) continue;
    const folded = foldForSearch(name);
    if (q && !folded.split(/[\s'-]+/).some((word) => word.startsWith(q))) continue;
    seen.add(key);
    rows.push({ id: member.id, displayName: name, folded, at: member.lastSpokeAt ?? 0 });
  }
  rows.sort((a, b) => b.at - a.at || a.folded.localeCompare(b.folded));
  return rows.map(({ id, displayName }) => ({ id, displayName }));
}
