/**
 * User id inside `@[…]` — 64 lowercase hex chars (OIDC sub, no dashes).
 * @see {@link EXAMPLE_MENTION_USER_ID}
 */
export const MENTION_USER_ID_PATTERN = '[0-9a-f]{64}';

/** Example OIDC sub (64 hex, no dashes) — use in tests and docs. */
export const EXAMPLE_MENTION_USER_ID =
  'd82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2';

/** Canonical mention token inserted by autocomplete: `@[userId]`. */
export const MENTION_UUID_TOKEN_RE = new RegExp(`@\\[(${MENTION_USER_ID_PATTERN})\\]`, 'gi');

/** Internal markdown href prefix consumed by PostMentionLink (`#mention-{id}`). */
export const MENTION_HREF_PREFIX = '#mention-';

/** Normalizes a user id for mention tokens (trim + lowercase hex). */
export function normalizeMentionUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

/** Whether `value` is a valid mention target id (64 hex). */
export function isMentionUserId(value: string): boolean {
  return new RegExp(`^${MENTION_USER_ID_PATTERN}$`, 'i').test(normalizeMentionUserId(value));
}

/** @deprecated use {@link isMentionUserId} */
export const isUserUuid = isMentionUserId;

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
