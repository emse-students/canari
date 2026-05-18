import { getUserDisplayNameSync } from '$lib/utils/users/displayName';

export type TextMentionPart =
  | { type: 'text'; value: string }
  | { type: 'mention'; userId: string; label: string }
  | { type: 'hashtag'; value: string };

const MENTION_TOKEN_RE =
  /@\[([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]|#([\wÀ-ž]{2,50})/gi;

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
      const userId = uuid.toLowerCase();
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
