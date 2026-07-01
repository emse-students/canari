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

export type HeadingLevel = 1 | 2 | 3;

export type ParsedHeadingLine = {
  level: HeadingLevel;
  /** Muted prefix in the editor (`# `, `## `, or lone `#` while typing). */
  marker: string;
  /** Remainder of the line; parsed with inline markdown. */
  content: string;
};

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

const HEADING_LINE_RE = /^(#{1,3})(\s+)(.*)$/;

/** Opening fence: line starts with triple backticks (optional language tag). */
export const FENCE_OPEN_LINE_RE = /^```/;

/** Closing fence: line is only triple backticks with optional trailing spaces. */
export const FENCE_CLOSE_LINE_RE = /^```\s*$/;

export type ComposerLineKind = 'normal' | 'fence-open' | 'fence-close' | 'code';

export type ClassifiedComposerLine = {
  kind: ComposerLineKind;
  line: string;
};

/**
 * Classifies each line for composer preview, tracking fenced ``` code blocks.
 * Inside a block, inline markdown and headings are not parsed.
 */
export function classifyComposerLines(text: string): ClassifiedComposerLine[] {
  const lines = text.split('\n');
  const result: ClassifiedComposerLine[] = [];
  let inBlock = false;

  for (const line of lines) {
    if (!inBlock && FENCE_OPEN_LINE_RE.test(line)) {
      result.push({ kind: 'fence-open', line });
      inBlock = true;
      continue;
    }
    if (inBlock && FENCE_CLOSE_LINE_RE.test(line)) {
      result.push({ kind: 'fence-close', line });
      inBlock = false;
      continue;
    }
    if (inBlock) {
      result.push({ kind: 'code', line });
      continue;
    }
    result.push({ kind: 'normal', line });
  }

  return result;
}

/**
 * True when `text` and `lastRendered` share the same fenced layout and only `code` line bodies differ.
 * Those lines are plain monospace spans and do not need a full composer DOM rebuild per keystroke.
 */
export function isFenceBodyContentChange(text: string, lastRendered: string): boolean {
  const current = classifyComposerLines(text);
  const previous = classifyComposerLines(lastRendered);
  if (current.length !== previous.length) return false;
  if (!current.some((line) => line.kind === 'code')) return false;
  for (let i = 0; i < current.length; i++) {
    const a = current[i];
    const b = previous[i];
    if (a.kind !== b.kind) return false;
    if (a.kind !== 'code' && a.line !== b.line) return false;
  }
  return true;
}

/**
 * ATX heading at line start: `# title`, `## title`, `### title`.
 * Also matches incomplete lines `##` or `## ` while typing.
 */
export function parseHeadingLine(line: string): ParsedHeadingLine | null {
  const hashesOnly = line.match(/^(#{1,3})$/);
  if (hashesOnly) {
    return {
      level: hashesOnly[1].length as HeadingLevel,
      marker: hashesOnly[1],
      content: '',
    };
  }

  const m = line.match(HEADING_LINE_RE);
  if (!m) return null;

  return {
    level: m[1].length as HeadingLevel,
    marker: m[1] + m[2],
    content: m[3],
  };
}

function inlineStructureKey(line: string): string {
  return parseInlineMarkdownPreview(line)
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

/** True when the text contains headings, fenced code blocks, and/or closed inline markdown spans. */
export function hasFormattedMarkdownPreview(text: string): boolean {
  if (!text) return false;
  for (const { kind, line } of classifyComposerLines(text)) {
    if (kind === 'fence-open' || kind === 'fence-close' || kind === 'code') return true;
    if (parseHeadingLine(line)) return true;
    if (parseInlineMarkdownPreview(line).some((s) => s.kind !== 'text')) return true;
  }
  return false;
}

/**
 * Stable key for markdown preview *structure* (delimiters / span kinds), not inner text.
 * Used to avoid re-rendering the composer DOM on every keystroke inside `*italic*`.
 */
function fencedLineStructureKey(kind: ComposerLineKind): string {
  switch (kind) {
    case 'fence-open':
      return 'fence:open';
    case 'fence-close':
      return 'fence:close';
    case 'code':
      return 'fence:line';
    case 'normal':
      return '';
  }
}

export function markdownStructureKey(text: string): string {
  return classifyComposerLines(text)
    .map(({ kind, line }) => {
      if (kind !== 'normal') return fencedLineStructureKey(kind);
      const heading = parseHeadingLine(line);
      if (heading) return `h${heading.level}|${inlineStructureKey(heading.content)}`;
      return inlineStructureKey(line);
    })
    .join('\n');
}
