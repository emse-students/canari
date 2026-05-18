import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import {
  MENTION_HREF_PREFIX,
  mentionTokenInTextRegex,
  normalizeMentionUserId,
} from '$lib/utils/mentions';

/**
 * Single newlines in markdown are normally collapsed; convert them to hard breaks
 * (two trailing spaces) so one Enter in the composer renders as one line break.
 * Double newlines stay as paragraph separators.
 */
export function normalizePostLineBreaks(md: string): string {
  const normalized = md.replace(/\r\n/g, '\n');
  return normalized.replace(/(?<!\n)\n(?!\n)/g, '  \n');
}

/**
 * Preprocesses post markdown to convert `@[uuid]` mentions and #hashtags into
 * markdown links with special internal hrefs that PostMentionLink intercepts.
 *
 * - @[uuid] → [@DisplayName](#mention-uuid)
 * - #word   → [#word](#hashtag-word)
 */
export function preprocessPostMarkdown(md: string): string {
  const withMentions = md.replace(mentionTokenInTextRegex(), (_, userId: string) => {
    const id = normalizeMentionUserId(userId);
    const label = getUserDisplayNameSync(id, id);
    return `[@${label}](${MENTION_HREF_PREFIX}${id})`;
  });

  const withHashtags = withMentions.replace(
    /(?<![[\w@./&#(])#([\wÀ-ž]{2,50})/g,
    '[#$1](#hashtag-$1)'
  );
  return normalizePostLineBreaks(withHashtags);
}
