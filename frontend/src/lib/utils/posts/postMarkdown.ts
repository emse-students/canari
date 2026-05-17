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
 * Preprocesses post markdown to convert @mentions and #hashtags into
 * markdown links with special internal hrefs that PostMentionLink.svelte
 * intercepts for custom rendering and navigation.
 *
 * - @word  → [@word](#mention-word)
 * - #word  → [#word](#hashtag-word)
 *
 * Lookbehind prevents double-processing and avoids email addresses / URLs.
 */
export function preprocessPostMarkdown(md: string): string {
  // Mentions: @word not preceded by a URL/link/email character or opening paren
  const withMentions = md.replace(/(?<![[\w@./&#(])@([\wÀ-ž]{1,50})/g, '[@$1](#mention-$1)');
  // Hashtags: #word (2+ chars) not preceded by a URL/link character or opening paren
  // Runs after mentions so (#mention-...) URLs are protected by the `(` lookbehind.
  const withHashtags = withMentions.replace(
    /(?<![[\w@./&#(])#([\wÀ-ž]{2,50})/g,
    '[#$1](#hashtag-$1)'
  );
  return normalizePostLineBreaks(withHashtags);
}
