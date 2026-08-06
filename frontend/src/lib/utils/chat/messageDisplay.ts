import { formatMentionsForPreview } from '$lib/utils/mentions.parse';

/** Pure display utilities for rendering message text, URLs, GIFs, and bubble shapes. */

/** Shortens a reply preview to at most 84 characters. */
export function shortenReplyPreview(text: string): string {
  if (!text) return '';
  const normalized = formatMentionsForPreview(text).replace(/\s+/g, ' ').trim();
  if (normalized.length <= 84) return normalized;
  return `${normalized.slice(0, 81)}…`;
}

/**
 * A URL runs to the next whitespace or angle bracket - closing brackets are NOT a boundary.
 *
 * Excluding `)`, `]` and `}` from the match is the obvious way to stop "see (https://x.com)" from
 * swallowing the closing paren, and it silently truncates every URL that legitimately contains one.
 * Wikipedia's disambiguation paths are the canonical case: `.../wiki/Signal_(application)` was cut
 * to `.../wiki/Signal_(application`, so the rendered `<a href>` pointed at a page that does not
 * exist and the preview endpoint answered 400. Balance decides instead - see below.
 */
const HTTP_URL_RE = /https?:\/\/[^\s<>"']+/gi;

/** Closing bracket to its opening counterpart, for the balance test in the trimmer. */
const BRACKET_PAIRS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * Trims trailing punctuation often pasted after a URL, KEEPING brackets that belong to it.
 *
 * Sentence punctuation always goes. A closing bracket only goes when it is unbalanced - i.e. the
 * URL contains more of it than of its opening counterpart - which is exactly the "(https://x.com)"
 * case, while `Signal_(application)` keeps its own. Loops because the two kinds interleave:
 * `(https://x.com/a_(b)).` has to shed `.`, then `)`, then stop.
 */
export function trimUrlTrailingPunctuation(url: string): string {
  let out = url;
  for (;;) {
    const stripped = out.replace(/[,.!?;:>]+$/, '');
    if (stripped !== out) {
      out = stripped;
      continue;
    }
    const open = BRACKET_PAIRS[out.at(-1) ?? ''];
    if (!open) break;
    const close = out.at(-1) as string;
    const closes = out.split(close).length - 1;
    const opens = out.split(open).length - 1;
    if (closes <= opens) break;
    out = out.slice(0, -1);
  }
  return out;
}

/** True when the URL is a Markdown autolink (`<https://…>`), which must not trigger embeds. */
export function isAngleBracketAutolink(text: string, urlStart: number, urlEnd: number): boolean {
  return urlStart > 0 && text[urlStart - 1] === '<' && urlEnd < text.length && text[urlEnd] === '>';
}

/** Extracts the first HTTP/HTTPS URL eligible for a link preview (skips `<url>` autolinks). */
export function extractFirstUrl(text: string): string | null {
  const re = new RegExp(HTTP_URL_RE.source, HTTP_URL_RE.flags);
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    const url = trimUrlTrailingPunctuation(raw);
    const start = match.index;
    const end = start + raw.length;
    if (isAngleBracketAutolink(text, start, end)) continue;
    return url;
  }

  return null;
}

/** Returns true if the URL points to an animated GIF (tenor, giphy, or .gif extension). */
export function isGifUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('tenor.com') || host.includes('giphy.com')) return true;
    if (/\.gif(\?.*)?$/i.test(u.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

/** Converts a Tenor or Giphy page URL to a direct .gif embed URL when possible. */
export function getGifEmbedUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    // Tenor /view/… pages → media.tenor.com embed
    if (host.includes('tenor.com') && u.pathname.includes('/view/')) {
      return `https://media.tenor.com/${u.pathname.split('-').pop()}/tenor.gif`;
    }
    // Giphy /gifs/ or /media/ pages → direct giphy media URL
    if (host.includes('giphy.com')) {
      const match = u.pathname.match(/(?:gifs|media)\/(?:.*-)?([a-zA-Z0-9]+)$/);
      if (match) return `https://media.giphy.com/media/${match[1]}/giphy.gif`;
    }
  } catch {
    /* fallback */
  }
  return url;
}

export type TextLinkSegment =
  | { type: 'text'; value: string }
  /** Clickable URL; may show inline GIF when not `noEmbed`. */
  | { type: 'link'; value: string; noEmbed?: boolean };

/** Splits a text string into alternating text and link segments for inline rendering. */
export function splitTextWithLinks(text: string): TextLinkSegment[] {
  const regex = new RegExp(HTTP_URL_RE.source, HTTP_URL_RE.flags);
  const segments: TextLinkSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const url = trimUrlTrailingPunctuation(raw);
    const start = match.index;
    const end = start + raw.length;
    const autolink = isAngleBracketAutolink(text, start, end);

    if (start > lastIndex) {
      segments.push({ type: 'text', value: text.slice(lastIndex, start - (autolink ? 1 : 0)) });
    }

    if (autolink) {
      segments.push({ type: 'text', value: '<' });
      segments.push({ type: 'link', value: url, noEmbed: true });
      segments.push({ type: 'text', value: '>' });
      lastIndex = end + 1;
      continue;
    }

    segments.push({ type: 'link', value: url });
    // Resume after the LINK, not after the raw match: whatever the trimmer shed is sentence
    // punctuation that belongs to the message, and skipping it deletes it from what the reader
    // sees. "voir https://x.com." rendered without its full stop; now the regex also captures
    // closing brackets, so "(https://x.com)" would have lost its ")" the same way.
    lastIndex = start + url.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', value: text.slice(lastIndex) });
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', value: text });
  }

  return segments;
}

/** Splits a text string into highlighted and non-highlighted parts for search result display. */
export function splitWithHighlight(
  text: string,
  needle: string
): Array<{ text: string; hit: boolean }> {
  if (!needle) return [{ text, hit: false }];
  const lowerText = text.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lowerText.indexOf(lowerNeedle, cursor);
    if (idx === -1) {
      parts.push({ text: text.slice(cursor), hit: false });
      break;
    }
    if (idx > cursor) {
      parts.push({ text: text.slice(cursor, idx), hit: false });
    }
    parts.push({ text: text.slice(idx, idx + needle.length), hit: true });
    cursor = idx + needle.length;
  }

  return parts.length > 0 ? parts : [{ text, hit: false }];
}

/** Returns Tailwind border-radius classes for a bubble based on its position in a message group. */
export function getBubbleShapeClass(
  position: 'single' | 'start' | 'middle' | 'end',
  isOwn: boolean
): string {
  if (position === 'single') return 'rounded-[1.25rem]';

  if (isOwn) {
    if (position === 'start') return 'rounded-[1.25rem] rounded-br-md';
    if (position === 'middle') return 'rounded-[1.25rem] rounded-tr-md rounded-br-md';
    return 'rounded-[1.25rem] rounded-tr-md';
  }

  if (position === 'start') return 'rounded-[1.25rem] rounded-bl-md';
  if (position === 'middle') return 'rounded-[1.25rem] rounded-tl-md rounded-bl-md';
  return 'rounded-[1.25rem] rounded-tl-md';
}
