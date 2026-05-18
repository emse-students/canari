/** Compact user id inside `@[…]` — 32 lowercase hex chars, no dashes. */
export const MENTION_USER_ID_PATTERN = '[0-9a-f]{32}';

/** Canonical mention token inserted by autocomplete: `@[userId]`. */
export const MENTION_UUID_TOKEN_RE = new RegExp(`@\\[(${MENTION_USER_ID_PATTERN})\\]`, 'gi');

/** Internal markdown href prefix consumed by PostMentionLink (`#mention-{id}`). */
export const MENTION_HREF_PREFIX = '#mention-';

/** Normalizes a user id for mention tokens (lowercase, no dashes). */
export function normalizeMentionUserId(userId: string): string {
  return userId.trim().toLowerCase().replace(/-/g, '');
}

export function isUserUuid(value: string): boolean {
  return new RegExp(`^${MENTION_USER_ID_PATTERN}$`, 'i').test(normalizeMentionUserId(value));
}

/** Extracts user IDs from `@[id]` tokens (deduplicated, normalized). */
export function extractMentionUserIds(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(MENTION_UUID_TOKEN_RE)) {
    ids.add(normalizeMentionUserId(match[1]));
  }
  return [...ids];
}

/** Builds the stored mention token for a user id. */
export function formatMentionToken(userId: string): string {
  return `@[${normalizeMentionUserId(userId)}]`;
}

/** Regex for `@[id]` in post markdown (negative lookbehind, same id format). */
export function mentionTokenInTextRegex(): RegExp {
  return new RegExp(`(?<![[\\w@./&#(])@\\[(${MENTION_USER_ID_PATTERN})\\]`, 'gi');
}
