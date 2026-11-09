/**
 * Strips lightweight Markdown to plain text for meta descriptions and one-line excerpts.
 *
 * A hyphen is only markup as a LIST MARKER ("- " at the start of a line) or a horizontal rule
 * ("---" alone on a line); anywhere else it is text, so "Saint-Etienne", an en/em dash and a
 * spaced " - " survive untouched.
 */
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .split('\n')
    .map((line) =>
      /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) ? ' ' : line.replace(/^\s*[-*+]\s+/, ' ')
    )
    .join(' ')
    .replace(/[#*_~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Shortens text for a meta tag, cutting BETWEEN words and appending an ellipsis.
 *
 * `max` counts the ellipsis, so the result never exceeds it. A cut inside a word ("au foy...") is
 * what an unfurler then displays verbatim, so the cut steps back to the last space - unless that
 * would throw away more than half the budget (one long unbroken token), where a hard cut is the
 * lesser evil. Punctuation left dangling before the ellipsis (`soiree,...`) is dropped too.
 */
export function truncateForMeta(text: string, max = 160): string {
  const plain = text.trim();
  // CODE POINTS, NOT UTF-16 UNITS: a hard cut at a unit index can land between the two halves of an
  // emoji (a surrogate pair) and leave a lone surrogate, which an unfurler shows as a replacement
  // character. `max` therefore counts characters as a person does.
  const chars = Array.from(plain);
  if (chars.length <= max) return plain;
  const hard = chars.slice(0, max - 1);
  // A cut that lands exactly on a word end keeps that word whole.
  const endsOnWord = /\s/.test(chars[max - 1]);
  const lastSpace = hard.lastIndexOf(' ');
  const cut = (endsOnWord || lastSpace < max / 2 ? hard : hard.slice(0, lastSpace)).join('');
  // – and — are the en and em dashes; … is the single-character ellipsis.
  return `${cut.replace(/[\s,;:.!?–—-]+$/u, '')}…`;
}
