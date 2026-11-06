/**
 * Inline markdown preview segments for composer contenteditable.
 * Delimiters are shown muted; closed spans render formatted. `\` escapes the next character.
 *
 * THE PUBLISHED POST DECIDES (`docs/wiki/frontend/markdown-coherence.md`): this hand parser exists
 * only because a contenteditable cannot host the renderer, so it must pair exactly what marked pairs
 * (`markdownParity.test.ts` renders one corpus through both). Hence `__x__` is BOLD, not an
 * underline the post never shows, and a single `*` / `_` follows CommonMark flanking. The one
 * deliberate tolerance, mirrored from the renderer (`emphasisTolerance.ts`), is whitespace just
 * inside a double marker (`**x **`); `PairingIndex` answers it in linear time.
 *
 * Text styles (italic, bold, strike) combine. Inline code does not combine with
 * other styles; delimiters inside a code span are not parsed.
 */

import { isSpace, isWordChar, urlLengthAt, urlMayStartAt } from './markdownText';

export type InlineMarkdownStyle = 'italic' | 'bold' | 'strike';

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

type DelimiterKind = 'italic' | 'bold' | 'boldItalic' | 'strike' | 'code';

type DelimiterSpec = {
  marker: string;
  kind: DelimiterKind;
};

const DELIMITERS: DelimiterSpec[] = [
  { marker: '***', kind: 'boldItalic' },
  { marker: '**', kind: 'bold' },
  { marker: '__', kind: 'bold' },
  { marker: '~~', kind: 'strike' },
  { marker: '~', kind: 'strike' },
  { marker: '`', kind: 'code' },
  { marker: '*', kind: 'italic' },
  { marker: '_', kind: 'italic' },
];

const STYLES_BY_KIND: Record<Exclude<DelimiterKind, 'code'>, InlineMarkdownStyle[]> = {
  italic: ['italic'],
  bold: ['bold'],
  boldItalic: ['bold', 'italic'],
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

const WORD_OR_MARKER = /[*_~\p{L}\p{N}]/u;

/**
 * EVERYTHING THE PAIRING NEEDS, COMPUTED ONCE PER TEXT IN LINEAR TIME. The preview re-parses on
 * every keystroke, and answering "where does this marker close?" by scanning (and slicing) from each
 * opener made a line of stray markers cubic: 20000 characters of `**a ` took two minutes. Here every
 * closer search is an array lookup, so the whole parse is O(n) plus the nesting depth.
 */
class PairingIndex {
  private nonSpace: Int32Array | null = null;
  private readonly doubles = new Map<string, DoubleMarkerIndex>();
  private readonly singles = new Map<string, Int32Array>();
  private codeRuns: Map<number, { length: number; next: number }> | null = null;

  constructor(readonly text: string) {}

  /** Number of non-whitespace characters before each position. */
  nonSpaceBefore(position: number): number {
    if (!this.nonSpace) {
      const counts = new Int32Array(this.text.length + 1);
      for (let i = 0; i < this.text.length; i++) {
        counts[i + 1] = counts[i] + (/\s/.test(this.text[i]) ? 0 : 1);
      }
      this.nonSpace = counts;
    }
    return this.nonSpace[position];
  }

  double(marker: string): DoubleMarkerIndex {
    let index = this.doubles.get(marker);
    if (!index) {
      index = new DoubleMarkerIndex(this, marker);
      this.doubles.set(marker, index);
    }
    return index;
  }

  /** Position of the first valid closer of a single `*` / `_` / `~` at or after each position. */
  singleCloserFrom(marker: string): Int32Array {
    let next = this.singles.get(marker);
    if (!next) {
      const { text } = this;
      next = new Int32Array(text.length + 1).fill(-1);
      for (let i = text.length - 1; i >= 0; i--) {
        next[i] = next[i + 1];
        if (text[i] !== marker || isEscapedAt(text, i)) continue;
        if (text[i + 1] === marker || text[i - 1] === marker) continue;
        if (isSpace(text[i - 1])) continue;
        if (marker === '_' && isWordChar(text[i + 1])) continue;
        next[i] = i;
      }
      this.singles.set(marker, next);
    }
    return next;
  }

  /** For each backtick run: its length and the start of the next run of EXACTLY that length. */
  codeRun(start: number): { length: number; next: number } | undefined {
    if (!this.codeRuns) {
      const runs: Array<{ start: number; length: number }> = [];
      for (let i = 0; i < this.text.length; i++) {
        if (this.text[i] !== '`') continue;
        let length = 1;
        while (this.text[i + length] === '`') length++;
        runs.push({ start: i, length });
        i += length - 1;
      }
      const lastByLength = new Map<number, number>();
      const map = new Map<number, { length: number; next: number }>();
      for (let r = runs.length - 1; r >= 0; r--) {
        map.set(runs[r].start, {
          length: runs[r].length,
          next: lastByLength.get(runs[r].length) ?? -1,
        });
        lastByLength.set(runs[r].length, runs[r].start);
      }
      this.codeRuns = map;
    }
    return this.codeRuns.get(start);
  }
}

/**
 * The occurrences of one DOUBLE marker (`**`, `__`, `~~`, `***`) in a text, with the prefix sums
 * that answer each pairing question in O(1) instead of by scanning.
 */
class DoubleMarkerIndex {
  readonly positions: number[] = [];
  private readonly slotOf: Int32Array;
  /** Index of the first occurrence at or after each occurrence that is a valid STRICT closer. */
  private readonly nextStrict: Int32Array;
  /** Real closers / openers at or after each occurrence (not in a longer run, flanked as such). */
  private readonly closersFrom: Int32Array;
  private readonly openersFrom: Int32Array;
  private readonly underscore: boolean;

  constructor(
    private readonly pairing: PairingIndex,
    private readonly marker: string
  ) {
    const { text } = pairing;
    const length = marker.length;
    const char = marker[0];
    this.underscore = char === '_';
    this.slotOf = new Int32Array(text.length + 1).fill(-1);
    for (let i = 0; i <= text.length - length;) {
      if (text.startsWith(marker, i) && !isEscapedAt(text, i)) {
        this.slotOf[i] = this.positions.length;
        this.positions.push(i);
        i += length;
      } else {
        i++;
      }
    }
    const count = this.positions.length;
    this.nextStrict = new Int32Array(count + 1).fill(-1);
    this.closersFrom = new Int32Array(count + 1);
    this.openersFrom = new Int32Array(count + 1);
    for (let k = count - 1; k >= 0; k--) {
      const i = this.positions[k];
      const before = text[i - 1];
      const after = text[i + length];
      this.nextStrict[k] = this.isStrictCloser(i) ? k : this.nextStrict[k + 1];
      const longerRun = before === char || after === char;
      this.closersFrom[k] = this.closersFrom[k + 1] + (!longerRun && !isSpace(before) ? 1 : 0);
      this.openersFrom[k] = this.openersFrom[k + 1] + (!longerRun && !isSpace(after) ? 1 : 0);
    }
  }

  private isStrictCloser(i: number): boolean {
    const { text } = this.pairing;
    if (isSpace(text[i - 1])) return false;
    return !(this.underscore && isWordChar(text[i + this.marker.length]));
  }

  slot(position: number): number {
    return this.slotOf[position];
  }

  /**
   * Whether the span from occurrence `open` to occurrence `close` may be read as emphasis although
   * whitespace touches the inside of a marker. A span with no whitespace inside is plain CommonMark
   * and always accepted. Rejected, because it would be a stray marker and not an emphasis:
   * the inside holds the marker (`5 ** 2 ... **important**`), the closer is glued to a letter, a
   * digit or a marker (`x ** y **bold**`), a `__` opener sits inside a word, or more real closers
   * follow than real openers (the first would have closed OUR opener).
   */
  accepted(open: number, close: number): boolean {
    const { text } = this.pairing;
    const length = this.marker.length;
    const openAt = this.positions[open];
    const closeAt = this.positions[close];
    if (this.pairing.nonSpaceBefore(closeAt) - this.pairing.nonSpaceBefore(openAt + length) <= 0) {
      return false;
    }
    if (!isSpace(text[openAt + length]) && !isSpace(text[closeAt - 1])) return true;
    if (close !== open + 1) return false;
    const after = text[closeAt + length];
    if (after && WORD_OR_MARKER.test(after)) return false;
    if (this.underscore && isWordChar(text[openAt - 1])) return false;
    return this.closersFrom[close + 1] <= this.openersFrom[close + 1];
  }

  /**
   * The closer of the opener at `openAt`, pairing as marked does. An opener followed by text takes
   * the first closer that is not after whitespace (CommonMark), and may take the NEXT occurrence,
   * when it is after whitespace, only if `accepted` says it is no stray (`**TOP 5 **`). An opener
   * followed by whitespace (`** x**`) can only be that tolerated case: the next occurrence or nothing.
   * Only the next occurrence can be a loose closer (anything further has a marker inside), which is
   * why this is two lookups and not a scan.
   */
  closerOf(openAt: number): number {
    const { text } = this.pairing;
    const length = this.marker.length;
    const open = this.slotOf[openAt];
    const looseOpen = isSpace(text[openAt + length]);
    const first = open + 1;
    if (first >= this.positions.length) return -1;
    const firstAt = this.positions[first];
    const usable = !(this.underscore && isWordChar(text[firstAt + length]));
    if (usable && this.accepted(open, first)) return firstAt;
    if (looseOpen) return -1;
    const strict = this.nextStrict[first + 1];
    if (strict === -1) return -1;
    return this.accepted(open, strict) ? this.positions[strict] : -1;
  }
}

/** A single `*` / `_` / `~` opens only left-flanking (not before whitespace), `_` not after a word. */
function singleMarkerMayOpen(text: string, start: number, marker: string): boolean {
  if (text[start + 1] === marker || text[start - 1] === marker) return false;
  if (isSpace(text[start + 1])) return false;
  return !(marker === '_' && isWordChar(text[start - 1]));
}

function stylesForKind(kind: Exclude<DelimiterKind, 'code'>): InlineMarkdownStyle[] {
  return STYLES_BY_KIND[kind];
}

/** An inline code span: closes on a run of backticks of EXACTLY the opening length. */
function tryCodeSpan(
  index: PairingIndex,
  start: number
): { end: number; segments: InlinePreviewSegment[] } | null {
  const { text } = index;
  if (text[start - 1] === '`') return null;
  const run = index.codeRun(start);
  if (!run || run.next === -1) return null;
  const marker = '`'.repeat(run.length);
  const content = text.slice(start + run.length, run.next);
  if (content.length === 0 || content.includes('\n')) return null;
  return {
    end: run.next + run.length,
    segments: [
      { kind: 'delimiter', marker },
      { kind: 'code', marker, content },
      { kind: 'delimiter', marker },
    ],
  };
}

function tryDelimiter(
  index: PairingIndex,
  start: number,
  inheritedStyles: readonly InlineMarkdownStyle[],
  inheritedMarkers: readonly string[]
): { end: number; segments: InlinePreviewSegment[] } | null {
  const { text } = index;
  for (const spec of DELIMITERS) {
    if (!text.startsWith(spec.marker, start) || isEscapedAt(text, start)) continue;

    if (spec.kind === 'code') {
      const code = tryCodeSpan(index, start);
      if (code) return code;
      continue;
    }
    if (spec.marker.length === 1 && !singleMarkerMayOpen(text, start, spec.marker)) {
      continue;
    }
    if (spec.marker.startsWith('_') && isWordChar(text[start - 1])) continue;
    const contentStart = start + spec.marker.length;
    const closeIdx =
      spec.marker.length > 1
        ? index.double(spec.marker).closerOf(start)
        : index.singleCloserFrom(spec.marker)[contentStart];

    if (closeIdx === -1) continue;

    const content = text.slice(contentStart, closeIdx);
    if (content.trim().length === 0) continue;

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
  const index = new PairingIndex(text);
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

    // An autolinked URL is text: a `**` inside the address is not emphasis in the post.
    if ((text[i] === 'h' || text[i] === 'w') && urlMayStartAt(text, i)) {
      const url = urlLengthAt(text, i);
      if (url > 0) {
        textBuf += text.slice(i, i + url);
        i += url;
        continue;
      }
    }

    const del = tryDelimiter(index, i, inheritedStyles, inheritedMarkers);
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
