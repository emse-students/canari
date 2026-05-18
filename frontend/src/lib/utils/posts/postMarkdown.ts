import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import { MENTION_HREF_PREFIX } from '$lib/utils/mentions';

const MENTION_UUID_IN_TEXT_RE =
  /(?<![[\w@./&#(])@\[([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/gi;

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
  const withMentions = md.replace(MENTION_UUID_IN_TEXT_RE, (_, userId: string) => {
    const id = userId.toLowerCase();
    const label = getUserDisplayNameSync(id, id);
    return `[@${label}](${MENTION_HREF_PREFIX}${id})`;
  });

  const withHashtags = withMentions.replace(
    /(?<![[\w@./&#(])#([\wÀ-ž]{2,50})/g,
    '[#$1](#hashtag-$1)'
  );
  return normalizePostLineBreaks(withHashtags);
}
