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
 * - @[Full Name]  → [@[Full Name]](#mention-Full Name)   (multi-word, new format)
 * - @word         → [@word](#mention-word)               (single-word, legacy)
 * - #word         → [#word](#hashtag-word)
 *
 * Lookbehind prevents double-processing and avoids email addresses / URLs.
 */
export function preprocessPostMarkdown(md: string): string {
  // Mentions: @[name] (multi-word) or @word (legacy), not preceded by URL/link chars
  const withMentions = md.replace(
    /(?<![[\w@./&#(])@(?:\[([^\]\n]{1,100})\]|([\wÀ-ž]{1,50}))/g,
    (_, bracketed: string | undefined, word: string | undefined) => {
      const name = bracketed ?? word ?? '';
      const display = bracketed ? `@[${name}]` : `@${name}`;
      return `[${display}](#mention-${name})`;
    }
  );
  // Hashtags: #word (2+ chars) not preceded by a URL/link character or opening paren
  // Runs after mentions so (#mention-...) URLs are protected by the `(` lookbehind.
  const withHashtags = withMentions.replace(
    /(?<![[\w@./&#(])#([\wÀ-ž]{2,50})/g,
    '[#$1](#hashtag-$1)'
  );
  return normalizePostLineBreaks(withHashtags);
}
