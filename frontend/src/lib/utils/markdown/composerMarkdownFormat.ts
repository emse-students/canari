import { tick } from 'svelte';
import { m } from '$lib/paraglide/messages';
import { inlineSpans, type InlineSpan } from './inlinePreview';
import type MentionComposerInput from '$lib/components/shared/MentionComposerInput.svelte';

/** The text a toolbar action inserts when there is nothing selected, one per action. */
export interface FormatPlaceholders {
  bold: string;
  italic: string;
  strikethrough: string;
  heading: string;
  quote: string;
  code: string;
  list: string;
  link: string;
}

/** The result of one toolbar action: the new text and the selection to restore. */
export interface FormatResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/** The placeholders from the message catalogue (`messages/*.json`). */
export function catalogPlaceholders(): FormatPlaceholders {
  return {
    bold: m.md_placeholder_bold(),
    italic: m.md_placeholder_italic(),
    strikethrough: m.md_placeholder_strikethrough(),
    heading: m.md_placeholder_heading(),
    quote: m.md_placeholder_quote(),
    code: m.md_placeholder_code(),
    list: m.md_placeholder_list(),
    link: m.md_placeholder_link_text(),
  };
}

/**
 * What a line carries before its text: indentation, quote levels (`> > `), then ONE block marker -
 * a heading (`## `), a bullet or an ordered item (`1.` / `1)`), with its task box (`[ ]`). A nested
 * item (`  - sub`) and a quoted one (`> - item`) are therefore recognised, and never wrapped.
 */
const LINE_PREFIX_RE =
  /^([ \t]*)((?:>[ \t]?)*)(#{1,6}[ \t]+|(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/;
const HEADING_MARKER_RE = /^#/;
const LIST_MARKER_RE = /^(?:[-*+]|\d)/;

interface ParsedLine {
  indent: string;
  quotes: string;
  marker: string;
  rest: string;
}

function parseLine(text: string): ParsedLine {
  const m = LINE_PREFIX_RE.exec(text) as RegExpExecArray;
  const prefixLength = m[0].length;
  return { indent: m[1], quotes: m[2], marker: m[3] ?? '', rest: text.slice(prefixLength) };
}

/** Length of everything before the text of the line - the part an inline marker must never wrap. */
function prefixLength(text: string): number {
  return text.length - parseLine(text).rest.length;
}

const BLOCK_PREFIX = { heading: '## ', quote: '> ', list: '- ' } as const;

type BlockKind = keyof typeof BLOCK_PREFIX;
type InlineKind = 'bold' | 'italic' | 'strikethrough' | 'code';

/** `char` is the marker's character, `len` how many of it make ONE application. */
const INLINE: Record<InlineKind, { marker: string; char: string; len: number }> = {
  bold: { marker: '**', char: '*', len: 2 },
  italic: { marker: '*', char: '*', len: 1 },
  strikethrough: { marker: '~~', char: '~', len: 2 },
  code: { marker: '`', char: '`', len: 1 },
};

interface Line {
  start: number;
  end: number;
  text: string;
}

/** The lines `[selStart, selEnd]` touches (the caret's line when nothing is selected). */
function linesCovering(text: string, selStart: number, selEnd: number): Line[] {
  const lines: Line[] = [];
  let start = text.lastIndexOf('\n', selStart - 1) + 1;
  for (;;) {
    const nl = text.indexOf('\n', start);
    const end = nl === -1 ? text.length : nl;
    lines.push({ start, end, text: text.slice(start, end) });
    if (end >= selEnd || nl === -1) return lines;
    start = end + 1;
    // A selection that stops exactly at a line break does not touch the next line.
    if (selEnd > selStart && start >= selEnd) return lines;
  }
}

/** One style span on a line, in absolute positions. */
type StyleSpan = InlineSpan;

/** The spans of the style on a line, found by the pairing the editor itself draws. */
function styleSpans(
  lineText: string,
  lineStart: number,
  prefix: number,
  kind: InlineKind
): StyleSpan[] {
  const wanted = kind === 'strikethrough' ? 'strike' : kind;
  const offset = lineStart + prefix;
  return inlineSpans(lineText.slice(prefix))
    .filter((span) => span.kinds.includes(wanted))
    .map((span) => ({
      ...span,
      start: span.start + offset,
      contentStart: span.contentStart + offset,
      contentEnd: span.contentEnd + offset,
      end: span.end + offset,
    }));
}

/**
 * The selection with every run of this marker taken out: the whole selection is about to become ONE
 * span of the style, so a run inside it (`**a** and *b*` + bold), at its edge (`**a`) or a partial
 * one can only produce garbage (`****a**`). A bold run of 3 keeps its italic star, an italic run of
 * 3 keeps its bold pair. Never touched: an escaped marker, and a run with whitespace on both
 * sides (`2 * 3`), which is text and not a marker.
 */
function stripRuns(s: string, kind: InlineKind): string {
  const { char, len } = INLINE[kind];
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== char || s[i - 1] === '\\') {
      out += s[i];
      continue;
    }
    let run = 1;
    while (s[i + run] === char) run++;
    const literal = /\s/.test(s[i - 1] ?? ' ') && /\s/.test(s[i + run] ?? ' ');
    const drop = literal
      ? 0
      : kind === 'italic'
        ? run % 2
        : kind === 'code'
          ? run === 1
            ? 1
            : 0
          : run >= len
            ? len
            : 0;
    out += char.repeat(run - drop);
    i += run - 1;
  }
  return out;
}

/** What is left of a span's marker when ONE of its styles goes (`***` minus bold is `*`). */
function remainingMarker(span: StyleSpan, kind: InlineKind): string {
  if (span.marker !== '***') return '';
  return kind === 'bold' ? '*' : '**';
}

/** A piece of a split span: re-wrapped in its marker, edge whitespace outside, nothing if blank. */
function wrapPiece(raw: string, marker: string): string {
  if (raw.trim() === '') return raw;
  const lead = /^\s*/.exec(raw)?.[0] ?? '';
  const trail = /\s*$/.exec(raw)?.[0] ?? '';
  return `${lead}${marker}${raw.slice(lead.length, raw.length - trail.length)}${marker}${trail}`;
}

interface Segment {
  start: number;
  end: number;
  /** The maximal spans of the style that overlap the selection, when it lies wholly inside them. */
  covering: StyleSpan[] | null;
  /** Every span of the style on the segment's line, to extend the wrap over a half-covered one. */
  spans: StyleSpan[];
}

/**
 * A selection is "wholly inside the style" when every non-blank character of it that is not one of
 * the spans' own markers lies in the content of a span of the style.
 */
function coveringSpans(
  spans: StyleSpan[],
  start: number,
  end: number,
  text: string
): StyleSpan[] | null {
  const isMarker = (p: number) =>
    spans.some(
      (sp) => (p >= sp.start && p < sp.contentStart) || (p >= sp.contentEnd && p < sp.end)
    );
  let seen = false;
  for (let p = start; p < end; p++) {
    if (/\s/.test(text[p]) || isMarker(p)) continue;
    if (!spans.some((sp) => p >= sp.contentStart && p < sp.contentEnd)) return null;
    seen = true;
  }
  if (!seen) return null;
  const overlapping = spans.filter((sp) => sp.end > start && sp.start < end);
  return overlapping.filter(
    (sp) => !overlapping.some((o) => o !== sp && o.start <= sp.start && o.end >= sp.end)
  );
}

/**
 * Applies, or takes off, an inline style on the selection.
 *
 * What makes it render as the button promises (CommonMark refuses a marker that touches
 * whitespace on its inside, and the toolbar used to write exactly that):
 * - whitespace at either edge of the selection stays OUTSIDE the markers;
 * - the line's own prefix (indentation, quotes, `## `, `- `) is never wrapped, or the heading would
 *   stop being one - a multi-line selection is handled line by line, since a marker does not span
 *   the blocks of a list or a quote;
 * - ONE rule, as a word processor has it: a selection wholly inside the style already turns the
 *   style OFF, splitting the span around it (`soir` in `**Prix ce soir**` gives `**Prix ce** soir`,
 *   empty pieces dropped); anything else strips every inner run of that marker, partial edge runs
 *   included, and wraps the trimmed selection once. A span the selection crosses an edge of, or
 *   touches, is taken into the wrap whole (`soir** demain` over `**Prix ce soir** demain` gives
 *   `**Prix ce soir demain**`; bold on `b` in `**a**b` gives `**ab**`).
 */
function formatInline(
  kind: InlineKind,
  text: string,
  selStart: number,
  selEnd: number,
  ph: FormatPlaceholders
): FormatResult {
  const { marker } = INLINE[kind];
  const placeholder = ph[kind];
  const segments: Segment[] = [];

  if (selEnd > selStart) {
    for (const line of linesCovering(text, selStart, selEnd)) {
      const prefix = prefixLength(line.text);
      let start = Math.max(selStart, line.start + prefix);
      let end = Math.min(selEnd, line.end);
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (end <= start) continue;
      const spans = styleSpans(line.text, line.start, prefix, kind);
      segments.push({ start, end, covering: coveringSpans(spans, start, end, text), spans });
    }
  }

  if (segments.length === 0) {
    // Nothing but whitespace, or nothing: a placeholder at the caret, past the line's block marker.
    const line = linesCovering(text, selStart, selStart)[0];
    const prefix = prefixLength(line.text);
    const at = Math.max(selEnd, line.start + prefix);
    const start = at + marker.length;
    return {
      text: text.slice(0, at) + marker + placeholder + marker + text.slice(at),
      selStart: start,
      selEnd: start + placeholder.length,
    };
  }

  const off = segments.every((s) => s.covering);
  const mixed = !off && segments.some((s) => s.covering);
  let out = '';
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const seg of segments) {
    if (seg.covering && (off || mixed)) {
      if (mixed) {
        // Mixed selection: a line that already has the style keeps it.
        out += text.slice(cursor, seg.end);
        cursor = seg.end;
        continue;
      }
      // Off: every span over the selection is split around it; the selected text loses the style.
      for (const span of seg.covering) {
        out += text.slice(cursor, span.start);
        const from = Math.max(seg.start, span.contentStart);
        const to = Math.min(seg.end, span.contentEnd);
        const keep = remainingMarker(span, kind);
        out += wrapPiece(text.slice(span.contentStart, from), span.marker);
        out += keep;
        first = first === -1 ? out.length : first;
        out += stripRuns(text.slice(from, to), kind);
        last = out.length;
        out += keep;
        out += wrapPiece(text.slice(to, span.contentEnd), span.marker);
        cursor = span.end;
      }
      continue;
    }
    // ONE rule: not wholly inside the style, so the style is taken off every inner run and the
    // trimmed selection is wrapped once. Whitespace a strip exposes stays outside.
    // A span the selection crosses one edge of, or touches (`**a**b`), joins it whole: stripping
    // only its inner marker would leave the other one orphaned (`**a **b c**`).
    let from = seg.start;
    let to = seg.end;
    for (let grew = true; grew;) {
      grew = false;
      for (const sp of seg.spans) {
        if (sp.end >= from && sp.start <= to && (sp.start < from || sp.end > to)) {
          from = Math.min(from, sp.start);
          to = Math.max(to, sp.end);
          grew = true;
        }
      }
    }
    const body = text.slice(from, to);
    const stripped = stripRuns(body, kind);
    const core = stripped.trim() === '' ? body : stripped;
    const lead = /^\s*/.exec(core)?.[0] ?? '';
    const trail = core.trim() === '' ? '' : (/\s*$/.exec(core)?.[0] ?? '');
    out += text.slice(cursor, from) + lead + marker;
    first = first === -1 ? out.length : first;
    out += core.slice(lead.length, core.length - trail.length);
    last = out.length;
    out += marker + trail;
    cursor = to;
  }
  if (first === -1) {
    // Mixed selection where nothing was wrapped: the selection stays where it was.
    return { text, selStart, selEnd };
  }
  return { text: out + text.slice(cursor), selStart: first, selEnd: last };
}

/**
 * Toggles a block marker on every non-blank line of the selection. One marker per line: applying
 * `list` to a quoted line REPLACES the quote, and the same marker again removes it. A heading is any
 * `#`..`######` prefix, so the toolbar's `## ` toggles off an `# ` line instead of stacking.
 */
function formatBlock(
  kind: BlockKind,
  text: string,
  selStart: number,
  selEnd: number,
  placeholder: string
): FormatResult {
  const prefix = BLOCK_PREFIX[kind];
  const lines = linesCovering(text, selStart, selEnd);
  const eligible = lines.filter((l) => l.text.trim() !== '');

  if (eligible.length === 0) {
    const at = lines[0].start;
    const start = at + prefix.length;
    return {
      text: text.slice(0, at) + prefix + placeholder + text.slice(lines[0].end),
      selStart: start,
      selEnd: start + placeholder.length,
    };
  }

  const has = (p: ParsedLine): boolean =>
    kind === 'quote'
      ? p.quotes !== ''
      : kind === 'heading'
        ? HEADING_MARKER_RE.test(p.marker)
        : LIST_MARKER_RE.test(p.marker);
  /** The new line, and where its text starts. Quotes and nesting survive; one marker per line. */
  const rewrite = (p: ParsedLine, off: boolean): string => {
    if (kind === 'quote') {
      const quotes = off ? p.quotes.replace(/^>[ \t]?/, '') : '> ' + p.quotes;
      return p.indent + quotes + p.marker + p.rest;
    }
    // A heading is not nested, so its indentation goes (4 spaces would make it code).
    const indent = kind === 'heading' ? '' : p.indent;
    return indent + p.quotes + (off ? '' : prefix) + p.rest;
  };

  const off = eligible.every((l) => has(parseLine(l.text)));
  let out = '';
  let cursor = 0;
  let first = -1;
  let last = 0;
  let caret = selStart;
  for (const line of eligible) {
    const parsed = parseLine(line.text);
    const next = rewrite(parsed, off);
    out += text.slice(cursor, line.start);
    const textStart = out.length + next.length - parsed.rest.length;
    if (first === -1) first = textStart;
    if (line === eligible[0]) {
      const column = Math.max(0, selStart - line.start - (line.text.length - parsed.rest.length));
      caret = textStart + Math.min(column, parsed.rest.length);
    }
    out += next;
    last = out.length;
    cursor = line.end;
  }
  out += text.slice(cursor);

  if (selEnd === selStart) return { text: out, selStart: caret, selEnd: caret };
  return { text: out, selStart: first, selEnd: last };
}

/** `[label](url)`: whitespace stays outside, an existing link is unwrapped to its label. */
function formatLink(
  text: string,
  selStart: number,
  selEnd: number,
  placeholder: string
): FormatResult {
  let start = selStart;
  let end = selEnd;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  const body = text.slice(start, end);

  if (body === '') {
    // The selection lands on the placeholder itself, so its LENGTH decides where it ends -
    // a literal 6 was the length of the French word and silently mis-selected any other.
    return {
      text: text.slice(0, selStart) + `[${placeholder}](url)` + text.slice(selEnd),
      selStart: selStart + 1,
      selEnd: selStart + 1 + placeholder.length,
    };
  }
  const link = /^\[([^\]\n]*)\]\([^)\n]*\)$/.exec(body);
  if (link) {
    return {
      text: text.slice(0, start) + link[1] + text.slice(end),
      selStart: start,
      selEnd: start + link[1].length,
    };
  }
  const urlStart = start + body.length + 3;
  return {
    text: text.slice(0, start) + `[${body}](url)` + text.slice(end),
    selStart: urlStart,
    selEnd: urlStart + 3,
  };
}

/**
 * Pure core of the toolbar: the text and selection after `type` is applied to `[selStart, selEnd]`,
 * or `null` for an action it does not know. Every case is tabled in
 * `docs/wiki/frontend/markdown-coherence.md`, and `markdownParity.test.ts` renders the output of
 * each through the renderer to prove it comes out as the button says.
 */
export function computeComposerFormat(
  type: string,
  text: string,
  selStart: number,
  selEnd: number,
  ph: FormatPlaceholders = catalogPlaceholders()
): FormatResult | null {
  switch (type) {
    case 'bold':
    case 'italic':
    case 'strikethrough':
    case 'code':
      return formatInline(type, text, selStart, selEnd, ph);
    case 'heading':
      return formatBlock('heading', text, selStart, selEnd, ph.heading);
    case 'quote':
      return formatBlock('quote', text, selStart, selEnd, ph.quote);
    case 'list':
      return formatBlock('list', text, selStart, selEnd, ph.list);
    case 'link':
      return formatLink(text, selStart, selEnd, ph.link);
    default:
      return null;
  }
}

/**
 * Applies a markdown formatting action to a {@link MentionComposerInput} value.
 * Mirrors the toolbar behaviour in post / profile / association composers.
 */
export async function applyComposerMarkdownFormat(
  type: string,
  getText: () => string,
  setText: (text: string) => void,
  composer: MentionComposerInput | null
): Promise<void> {
  if (!composer) return;

  const { start, end } = composer.getSelectionRange();
  const result = computeComposerFormat(type, getText(), start, end);
  if (!result) return;

  setText(result.text);
  await tick();
  composer.focusEditor();
  composer.setSelectionRange(result.selStart, result.selEnd);
}
