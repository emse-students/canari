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
        // NO FALLBACK, and the id is emphatically not one. `getUserDisplayNameSync` is careful
        // never to return an id; passing one as the fallback put it straight back, so every
        // consumer of this parser - chat bodies, notification bodies, conversation previews -
        // rendered `@3f9a1c...` until something happened to warm the cache. A name that is not
        // known yet is rendered by the CALLER, which is the only side that can re-render when it
        // arrives; this function's job ends at the fact.
        type: 'mention',
        userId,
        label: getUserDisplayNameSync(userId),
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

/** Replaces `@[id]` tokens with `@DisplayName` for conversation previews and reply quotes. */
export function formatMentionsForPreview(text: string): string {
  if (!text || !text.includes('@[')) return text;
  const parts = splitTextWithMentions(text);
  if (parts.every((p) => p.type === 'text')) return text;
  return parts
    .map((p) => {
      if (p.type === 'mention') return `@${p.label}`;
      if (p.type === 'hashtag') return `#${p.value}`;
      return p.value;
    })
    .join('');
}
