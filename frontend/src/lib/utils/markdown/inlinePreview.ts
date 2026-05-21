/**
 * Discord-style inline markdown preview segments for composer contenteditable.
 * Delimiters are shown muted; closed spans render formatted. `\` escapes the next character.
 *
 * Text styles (italic, bold, underline, strike) combine. Inline code does not combine with
 * other styles; delimiters inside a code span are not parsed.
 */

export type InlineMarkdownStyle = 'italic' | 'bold' | 'underline' | 'strike';

export type InlinePreviewSegment =
  | { kind: 'text'; value: string }
  | { kind: 'escape'; char: string }
  | { kind: 'delimiter'; marker: string }
  | { kind: 'formatted'; styles: readonly InlineMarkdownStyle[]; marker: string; content: string }
  | { kind: 'code'; marker: string; content: string };

type DelimiterKind = 'italic' | 'underline' | 'bold' | 'boldItalic' | 'strike' | 'code';

type DelimiterSpec = {
  marker: string;
  kind: DelimiterKind;
};

const DELIMITERS: DelimiterSpec[] = [
  { marker: '***', kind: 'boldItalic' },
  { marker: '**', kind: 'bold' },
  { marker: '__', kind: 'underline' },
  { marker: '~~', kind: 'strike' },
  { marker: '`', kind: 'code' },
  { marker: '*', kind: 'italic' },
  { marker: '_', kind: 'italic' },
];

const STYLES_BY_KIND: Record<Exclude<DelimiterKind, 'code'>, InlineMarkdownStyle[]> = {
  italic: ['italic'],
  bold: ['bold'],
  boldItalic: ['bold', 'italic'],
  underline: ['underline'],
  strike: ['strike'],
};

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

function stylesForKind(kind: Exclude<DelimiterKind, 'code'>): InlineMarkdownStyle[] {
  return STYLES_BY_KIND[kind];
}

function tryDelimiter(
  text: string,
  start: number,
  inheritedStyles: readonly InlineMarkdownStyle[],
  inheritedMarkers: readonly string[]
): { end: number; segments: InlinePreviewSegment[] } | null {
  for (const spec of DELIMITERS) {
    if (!text.startsWith(spec.marker, start) || isEscapedAt(text, start)) continue;

    const contentStart = start + spec.marker.length;
    const closeIdx = findUnescapedMarker(text, spec.marker, contentStart);

    if (closeIdx === -1) continue;

    const content = text.slice(contentStart, closeIdx);
    if (content.length === 0) continue;
    if (spec.kind === 'code' && content.includes('\n')) continue;

    if (spec.kind === 'code') {
      return {
        end: closeIdx + spec.marker.length,
        segments: [
          { kind: 'delimiter', marker: spec.marker },
          { kind: 'code', marker: spec.marker, content },
          { kind: 'delimiter', marker: spec.marker },
        ],
      };
    }

    const added = stylesForKind(spec.kind);
    const inner = parseInlineMarkdownPreview(
      content,
      [...inheritedStyles, ...added],
      [...inheritedMarkers, spec.marker]
    );

    return {
      end: closeIdx + spec.marker.length,
      segments: [
        { kind: 'delimiter', marker: spec.marker },
        ...inner,
        { kind: 'delimiter', marker: spec.marker },
      ],
    };
  }
  return null;
}

/**
 * Parses a plain-text chunk (no mention tokens) into preview segments.
 */
export function parseInlineMarkdownPreview(
  text: string,
  inheritedStyles: readonly InlineMarkdownStyle[] = [],
  inheritedMarkers: readonly string[] = []
): InlinePreviewSegment[] {
  const segments: InlinePreviewSegment[] = [];
  let i = 0;
  let textBuf = '';

  const flushText = () => {
    if (!textBuf) return;
    if (inheritedStyles.length > 0) {
      segments.push({
        kind: 'formatted',
        styles: inheritedStyles,
        marker: inheritedMarkers[inheritedMarkers.length - 1] ?? '',
        content: textBuf,
      });
    } else {
      segments.push({ kind: 'text', value: textBuf });
    }
    textBuf = '';
  };

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length && !isEscapedAt(text, i)) {
      flushText();
      segments.push({ kind: 'escape', char: text[i + 1] });
      i += 2;
      continue;
    }

    const del = tryDelimiter(text, i, inheritedStyles, inheritedMarkers);
    if (del) {
      flushText();
      segments.push(...del.segments);
      i = del.end;
      continue;
    }

    textBuf += text[i];
    i++;
  }

  flushText();
  return segments;
}

/** True when the text contains at least one closed markdown span (italic, bold, etc.). */
export function hasFormattedMarkdownPreview(text: string): boolean {
  if (!text) return false;
  return parseInlineMarkdownPreview(text).some((s) => s.kind !== 'text');
}

/**
 * Stable key for markdown preview *structure* (delimiters / span kinds), not inner text.
 * Used to avoid re-rendering the composer DOM on every keystroke inside `*italic*`.
 */
export function markdownStructureKey(text: string): string {
  return parseInlineMarkdownPreview(text)
    .map((s) => {
      switch (s.kind) {
        case 'text':
          return 't';
        case 'escape':
          return 'e';
        case 'delimiter':
          return `d:${s.marker}`;
        case 'formatted':
          return `fmt:${[...s.styles].sort().join(',')}:${s.marker}`;
        case 'code':
          return `code:${s.marker}`;
      }
    })
    .join('|');
}
