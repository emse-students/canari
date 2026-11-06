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

/** A block marker at the start of a line: heading, quote, bullet or ordered item. */
const ANY_BLOCK_RE = /^(#{1,6}[ \t]+|>[ \t]?|(?:[-*+]|\d+\.)[ \t]+)/;
const BLOCK_RE = {
  heading: /^#{1,6}[ \t]+/,
  quote: /^>[ \t]?/,
  list: /^(?:[-*+]|\d+\.)[ \t]+/,
} as const;
const BLOCK_PREFIX = { heading: '## ', quote: '> ', list: '- ' } as const;

type BlockKind = keyof typeof BLOCK_RE;
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
): Segment['wrapped'] {
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
  return on ? { where } : null;
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
 * - already wrapped (markers inside the selection, or just around it) turns the format off.
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
      const prefix = ANY_BLOCK_RE.exec(line.text)?.[0].length ?? 0;
      let start = Math.max(selStart, line.start + prefix);
      let end = Math.min(selEnd, line.end);
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (end > start) segments.push({ start, end, wrapped: wrappingOf(text, start, end, kind) });
    }
  }

  if (segments.length === 0) {
    // Nothing but whitespace, or nothing: a placeholder at the caret, past the line's block marker.
    const line = linesCovering(text, selStart, selStart)[0];
    const prefix = ANY_BLOCK_RE.exec(line.text)?.[0].length ?? 0;
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
      out += text.slice(cursor, seg.start) + marker;
      first = first === -1 ? out.length : first;
      out += body;
      last = out.length;
      out += marker;
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

  const off = eligible.every((l) => BLOCK_RE[kind].test(l.text));
  let out = '';
  let cursor = 0;
  let first = -1;
  let last = 0;
  let caretDelta = 0;
  for (const line of eligible) {
    const existing = ANY_BLOCK_RE.exec(line.text)?.[0] ?? '';
    const body = line.text.slice(existing.length);
    const next = off ? body : prefix + body;
    out += text.slice(cursor, line.start);
    if (first === -1) first = out.length + (off ? 0 : prefix.length);
    out += next;
    last = out.length;
    cursor = line.end;
    if (line === eligible[0]) caretDelta = next.length - line.text.length;
  }
  out += text.slice(cursor);

  if (selEnd === selStart) {
    const caret = Math.max(first, selStart + caretDelta);
    return { text: out, selStart: caret, selEnd: caret };
  }
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
