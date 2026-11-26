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
 * THE CALL TO EVERY MEMBER: `@tous`, or its alias `@everyone`, as a whole word, any case. Plain text
 * rather than a reserved `@[...]` token, so every renderer that predates it - an older app, a native
 * banner, a reply quote - shows the word that was typed instead of a raw token. Not preceded by a
 * word character, `@`, `.` or `/` (so `mail@tous.fr` is no call), and not followed by a word
 * character or `-`. The SAME pattern is spelled by Android's `NotificationLevelGate` and the iOS
 * extension, pinned for all three by `libs/contracts/mention-decision.cases.json`.
 * See docs/wiki/services/chat-delivery.md, "@tous".
 */
export const MENTION_EVERYONE_PATTERN = '(?<![A-Za-z0-9_@./])@(?:tous|everyone)(?![A-Za-z0-9_-])';

/** Whether `text` calls every member of its conversation (see {@link MENTION_EVERYONE_PATTERN}). */
export function mentionsEveryone(text: string): boolean {
  return new RegExp(MENTION_EVERYONE_PATTERN, 'i').test(text);
}
