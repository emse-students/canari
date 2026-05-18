import { MENTION_USER_ID_PATTERN, normalizeMentionUserId } from '$lib/utils/mentions';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

export type TextMentionPart =
  | { type: 'text'; value: string }
  | { type: 'mention'; userId: string; label: string }
  | { type: 'hashtag'; value: string };

const MENTION_TOKEN_RE = new RegExp(`@\\[(${MENTION_USER_ID_PATTERN})\\]|#([\\wÀ-ž]{2,50})`, 'gi');

/** Splits plain text into `@[uuid]` mention and hashtag segments (chat bodies, previews). */
export function splitTextWithMentions(text: string): TextMentionPart[] {
  const parts: TextMentionPart[] = [];
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  const re = new RegExp(MENTION_TOKEN_RE.source, MENTION_TOKEN_RE.flags);

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push({ type: 'text', value: text.slice(lastIdx, match.index) });
    }
    const [token, uuid, hashtag] = match;
    if (uuid) {
      const userId = normalizeMentionUserId(uuid);
      parts.push({
        type: 'mention',
        userId,
        label: getUserDisplayNameSync(userId, userId),
      });
    } else if (hashtag) {
      parts.push({ type: 'hashtag', value: hashtag });
    } else {
      parts.push({ type: 'text', value: token });
    }
    lastIdx = match.index + token.length;
  }

  if (lastIdx < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIdx) });
  }
  return parts;
}
