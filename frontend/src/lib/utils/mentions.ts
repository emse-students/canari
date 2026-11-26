/**
 * User id inside `@[…]` - 64 lowercase hex chars (OIDC sub, no dashes).
 * @see {@link EXAMPLE_MENTION_USER_ID}
 */
export const MENTION_USER_ID_PATTERN = '[0-9a-f]{64}';

/** Example OIDC sub (64 hex, no dashes) - use in tests and docs. */
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

/**
 * THE CALL TO EVERY MEMBER IS A MENTION LIKE ANY OTHER (owner, 2026-11-26: "comme les autres
 * mentions"). A member is mentioned only when picked from the list, which writes the `@[<id>]` token;
 * a name typed out by hand stays text and rings nobody. `@tous` follows the same rule: picking the
 * row writes this token, drawn as a chip reading "@tous" / "@everyone"; the word typed by hand is
 * text. The id is no account id (those are 64 hex), so it can never name a member. The SAME token
 * is read by Android's `NotificationLevelGate` and the iOS extension and push handler, pinned for
 * all three by `libs/contracts/mention-decision.cases.json`. See docs/wiki/services/chat-delivery.md,
 * "@tous".
 */
export const MENTION_EVERYONE_ID = 'everyone';

/** The token a picked `@tous` writes: `@[everyone]`. */
export const MENTION_EVERYONE_TOKEN = `@[${MENTION_EVERYONE_ID}]`;

/** {@link MENTION_EVERYONE_TOKEN} as a regex source, for the parsers that cut tokens out of text. */
export const MENTION_EVERYONE_PATTERN = `@\\[${MENTION_EVERYONE_ID}\\]`;

/** Whether `text` calls every member of its conversation: it holds {@link MENTION_EVERYONE_TOKEN}. */
export function mentionsEveryone(text: string): boolean {
  return text.toLowerCase().includes(MENTION_EVERYONE_TOKEN);
}
