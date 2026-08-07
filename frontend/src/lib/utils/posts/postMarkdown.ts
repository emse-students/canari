import { BARE_DOMAIN_RE, trimUrlTrailingPunctuation } from '$lib/utils/chat/messageDisplay';
import { getUserDisplayNameSync } from '$lib/utils/users/displayName';
import {
  MENTION_HREF_PREFIX,
  mentionTokenInTextRegex,
  normalizeMentionUserId,
} from '$lib/utils/mentions';

/**
 * Converts bare domains (`canari-emse.fr`, no `https://` typed) into real markdown links,
 * sharing `BARE_DOMAIN_RE` with the chat renderer (messageDisplay.ts) so both surfaces agree on
 * what counts as a linkable domain - marked's own GFM autolinker only catches `www.`-prefixed
 * hosts and full URLs, never a bare one. Skips a match immediately followed by `](` - that means
 * it is already the label of a hand-written markdown link, and wrapping it again would nest
 * markdown link syntax inside itself.
 */
function linkifyBareDomains(md: string): string {
  const regex = new RegExp(BARE_DOMAIN_RE.source, BARE_DOMAIN_RE.flags);
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(md)) !== null) {
    const domain = trimUrlTrailingPunctuation(match[0]);
    const start = match.index;
    const end = start + domain.length;
    if (md.startsWith('](', end)) continue;
    result += md.slice(lastIndex, start) + `[${domain}](https://${domain})`;
    lastIndex = end;
  }
  result += md.slice(lastIndex);
  return result;
}

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
 * - bare domain → [domain](https://domain)
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
  const withBareDomains = linkifyBareDomains(withHashtags);
  return normalizePostLineBreaks(withBareDomains);
}
