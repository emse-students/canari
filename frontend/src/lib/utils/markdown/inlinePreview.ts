/**
 * Discord-style inline markdown preview segments for composer contenteditable.
 * Delimiters are shown muted; closed spans render formatted. `\` escapes the next character.
 */

export type InlinePreviewSegment =
  | { kind: 'text'; value: string }
  | { kind: 'escape'; char: string }
  | { kind: 'delimiter'; marker: string }
  | { kind: 'italic'; marker: string; content: string }
  | { kind: 'bold'; marker: string; content: string }
  | { kind: 'boldItalic'; marker: string; content: string }
  | { kind: 'strike'; marker: string; content: string }
  | { kind: 'code'; marker: string; content: string };

type DelimiterSpec = {
  marker: string;
  kind: 'italic' | 'bold' | 'boldItalic' | 'strike' | 'code';
};

const DELIMITERS: DelimiterSpec[] = [
  { marker: '***', kind: 'boldItalic' },
  { marker: '**', kind: 'bold' },
  { marker: '~~', kind: 'strike' },
  { marker: '`', kind: 'code' },
  { marker: '*', kind: 'italic' },
  { marker: '_', kind: 'italic' },
];

/** True when `index` is preceded by an odd number of backslashes. */
export function isEscapedAt(text: string, index: number): boolean {
  let backslashes = 0;
  for (let j = index - 1; j >= 0 && text[j] === '\\'; j--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

function findUnescapedMarker(text: string, marker: string, from: number): number {
  for (let i = from; i <= text.length - marker.length; i++) {
    if (isEscapedAt(text, i)) continue;
    if (text.startsWith(marker, i)) return i;
  }
  return -1;
}

function tryDelimiter(
  text: string,
  start: number
): { end: number; segments: InlinePreviewSegment[] } | null {
  for (const spec of DELIMITERS) {
    if (!text.startsWith(spec.marker, start) || isEscapedAt(text, start)) continue;

    const contentStart = start + spec.marker.length;
    const closeIdx = findUnescapedMarker(text, spec.marker, contentStart);

    if (closeIdx === -1) continue;

    const content = text.slice(contentStart, closeIdx);
    if (content.length === 0) continue;
    if (spec.kind === 'code' && content.includes('\n')) continue;

    return {
      end: closeIdx + spec.marker.length,
      segments: [
        { kind: 'delimiter', marker: spec.marker },
        { kind: spec.kind, marker: spec.marker, content },
        { kind: 'delimiter', marker: spec.marker },
      ],
    };
  }
  return null;
}

/**
 * Parses a plain-text chunk (no mention tokens) into preview segments.
 */
export function parseInlineMarkdownPreview(text: string): InlinePreviewSegment[] {
  const segments: InlinePreviewSegment[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && !isEscapedAt(text, i)) {
      segments.push({ kind: 'escape', char: text[i + 1] });
      i += 2;
      continue;
    }

    const del = tryDelimiter(text, i);
    if (del) {
      segments.push(...del.segments);
      i = del.end;
      continue;
    }

    let end = i + 1;
    while (end < text.length && tryDelimiter(text, end) === null) {
      end++;
    }
    segments.push({ kind: 'text', value: text.slice(i, end) });
    i = end;
  }

  return segments;
}

/** True when the text contains at least one closed markdown span (italic, bold, etc.). */
export function hasFormattedMarkdownPreview(text: string): boolean {
  if (!text) return false;
  return parseInlineMarkdownPreview(text).some((s) => s.kind !== 'text');
}
