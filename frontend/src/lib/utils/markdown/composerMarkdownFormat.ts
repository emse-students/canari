import { tick } from 'svelte';
import { m } from '$lib/paraglide/messages';
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

function runLength(s: string, char: string, fromEnd: boolean): number {
  let n = 0;
  while (n < s.length && s[fromEnd ? s.length - 1 - n : n] === char) n++;
  return n;
}

interface Segment {
  start: number;
  end: number;
  /** How the span is wrapped today: `inside` the span, `outside` it, or not at all. */
  wrapped: { where: 'inside' | 'outside' } | null;
}

/**
 * How many marker characters wrap the span `[start, end)` - inside its own edges (a selection that
 * includes the markers) or just outside it (a selection of the words only). The count decides the
 * toggle: bold is on at 2 or more, italic at an odd count, so `***x***` is both and `**x**` is not
 * italic.
 */
function wrappingOf(
  text: string,
  start: number,
  end: number,
  kind: InlineKind
): { where: 'inside' | 'outside'; conflict: boolean } | null {
  const { char, len } = INLINE[kind];
  const s = text.slice(start, end);
  const lead = runLength(s, char, false);
  const trail = runLength(s, char, true);
  let where: 'inside' | 'outside' = 'inside';
  let count = lead < s.length ? Math.min(lead, trail) : 0;
  if (count === 0) {
    where = 'outside';
    count = Math.min(
      runLength(text.slice(0, start), char, true),
      runLength(text.slice(end), char, false)
    );
  }
  const on = kind === 'italic' ? count % 2 === 1 : count >= len;
  if (!on) return null;
  // `**Prix** : 5 **ce soir**` selected whole STARTS and ENDS with the marker without being one
  // span: a marker run of the same kind inside means two spans, so there is nothing to unwrap.
  const inner = where === 'inside' ? s.slice(count, s.length - count) : s;
  return { where, conflict: hasMarkerRun(inner, kind) };
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

/** An unescaped run of the kind's marker inside `s` that would close or open a span of its own. */
function hasMarkerRun(s: string, kind: InlineKind): boolean {
  const { char, len } = INLINE[kind];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== char) continue;
    let run = 1;
    while (s[i + run] === char) run++;
    const escaped = s[i - 1] === '\\';
    if (!escaped && (kind === 'italic' ? run % 2 === 1 : run >= len)) return true;
    i += run - 1;
  }
  return false;
}

/**
 * Wraps, or unwraps, the selection in an inline marker.
 *
 * What makes it render as the button promises (CommonMark refuses a marker that touches
 * whitespace on its inside, and the toolbar used to write exactly that):
 * - whitespace at either edge of the selection stays OUTSIDE the markers;
 * - the line's own block marker (`## `, `> `, `- `) is never wrapped, or the heading would stop
 *   being one - a multi-line selection is wrapped line by line, since a marker does not span the
 *   blocks of a list or a quote;
 * - ONE rule, as a word processor has it: a selection wholly inside the style already (markers
 *   inside it, or just around it, and no other run of that marker within) turns the style off;
 *   anything else strips every inner run of that marker, partial edge runs included, and wraps the
 *   trimmed selection once.
 */
function formatInline(
  kind: InlineKind,
  text: string,
  selStart: number,
  selEnd: number,
  ph: FormatPlaceholders
): FormatResult {
  const { marker, len } = INLINE[kind];
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
      const state = wrappingOf(text, start, end, kind);
      segments.push({
        start,
        end,
        wrapped: state && !state.conflict ? { where: state.where } : null,
      });
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

  const off = segments.every((s) => s.wrapped);
  const mixed = !off && segments.some((s) => s.wrapped);
  let out = '';
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const seg of segments) {
    const body = text.slice(seg.start, seg.end);
    if (off && seg.wrapped?.where === 'inside') {
      out += text.slice(cursor, seg.start);
      first = first === -1 ? out.length : first;
      out += body.slice(len, body.length - len);
      last = out.length;
      cursor = seg.end;
    } else if (off && seg.wrapped?.where === 'outside') {
      out += text.slice(cursor, seg.start - len);
      first = first === -1 ? out.length : first;
      out += body;
      last = out.length;
      cursor = seg.end + len;
    } else if (mixed && seg.wrapped) {
      // Mixed selection: a line that already has the format keeps it.
      out += text.slice(cursor, seg.end);
      first = first === -1 ? out.length - body.length : first;
      last = out.length;
      cursor = seg.end;
    } else {
      // ONE rule: not wholly inside the style already, so the style is taken off every inner run
      // and the trimmed selection is wrapped once. Whitespace a strip exposes stays outside.
      const stripped = stripRuns(body, kind);
      const core = stripped.trim() === '' ? body : stripped;
      const lead = /^\s*/.exec(core)?.[0] ?? '';
      const trail = core.trim() === '' ? '' : (/\s*$/.exec(core)?.[0] ?? '');
      out += text.slice(cursor, seg.start) + lead + marker;
      first = first === -1 ? out.length : first;
      out += core.slice(lead.length, core.length - trail.length);
      last = out.length;
      out += marker + trail;
      cursor = seg.end;
    }
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
