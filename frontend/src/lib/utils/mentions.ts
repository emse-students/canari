/** Canonical mention token inserted by autocomplete: `@[user-uuid]`. */
export const MENTION_UUID_TOKEN_RE =
  /@\[([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/gi;

const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Internal markdown href prefix consumed by PostMentionLink (`#mention-{idOrLegacyName}`). */
export const MENTION_HREF_PREFIX = '#mention-';

export function isUserUuid(value: string): boolean {
  return UUID_ONLY_RE.test(value.trim());
}

/** Extracts user IDs from `@[uuid]` tokens (deduplicated, lowercased). */
export function extractMentionUserIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_UUID_TOKEN_RE)) {
    ids.add(match[1].toLowerCase());
  }
  return [...ids];
}

/** Builds the stored mention token for a user id. */
export function formatMentionToken(userId: string): string {
  return `@[${userId}]`;
}
