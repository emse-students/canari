import { tick } from 'svelte';
import { Marked } from 'marked';
import { showToast } from '$lib/stores/toast.svelte';
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
  /** True when the action could not be written cleanly: `text` is the input, unchanged. */
  refused?: true;
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

/** Every span on a line (any style, code included), found by the pairing the editor itself draws. */
function allSpans(lineText: string, lineStart: number, prefix: number): StyleSpan[] {
  const offset = lineStart + prefix;
  return inlineSpans(lineText.slice(prefix)).map((span) => ({
    ...span,
    start: span.start + offset,
    contentStart: span.contentStart + offset,
    contentEnd: span.contentEnd + offset,
    end: span.end + offset,
  }));
}

/** The name `inlineSpans` gives a toolbar action's style. */
const wantedKind = (kind: InlineKind) => (kind === 'strikethrough' ? 'strike' : kind);

/** The spans of the style among `all`. */
const styleSpans = (all: StyleSpan[], kind: InlineKind): StyleSpan[] =>
  all.filter((span) => span.kinds.includes(wantedKind(kind)));

type Style = 'strike' | 'bold' | 'italic';
/** The styles, outermost first: two runs that start and end together nest in this order. */
const STYLE_ORDER: Style[] = ['strike', 'bold', 'italic'];

interface Run {
  style: Style;
  a: number;
  b: number;
  /** Written with underscores (`_`, `__`) instead of stars. Never set on a strike. */
  under?: boolean;
}

/** The character a run's marker is made of: what decides whether two markers touch. */
const markChar = (r: Run): string => (r.style === 'strike' ? '~' : r.under ? '_' : '*');
const markOf = (r: Run): string =>
  r.style === 'strike' ? '~~' : r.style === 'bold' ? (r.under ? '__' : '**') : r.under ? '_' : '*';

/**
 * A span the model must rewrite for a selection `[from, to)`: it overlaps the selection, or it is of
 * the toggled style and touches it (`**a**b` + bold on `b` is ONE bold, `**ab**`).
 */
const reaches = (sp: StyleSpan, from: number, to: number, style: Style): boolean =>
  (sp.end > from && sp.start < to) ||
  (!sp.kinds.includes('code') && sp.kinds.includes(style) && (sp.end === from || sp.start === to));

/**
 * THE INLINE ACTION, from a per-character model, whenever a span touches the selection. Every
 * character keeps the styles it had, the selected ones gain (or, with `remove`, lose) this one, and
 * the whole nest of spans around the selection is written again:
 * - runs of one style are maximal and whitespace stays outside the markers (CommonMark refuses a
 *   marker that touches whitespace on its inside); a nested run of the SAME style is one run, since a
 *   strike inside a strike is one strike;
 * - a run that would cross another is cut at the crossing and reopened, the run of the other style
 *   first, and preferably where the pieces do not touch;
 * - the spelling is derived, in one pass, from how marked reads markers: two markers made of the
 *   same character never touch (`***a***`, `**a****b**` are read several ways, and a `**` opened
 *   straight after another run is not read at all). Where two star markers would touch, the italic
 *   is written with `_` when no letter or digit touches it on the outside (underscore emphasis is
 *   refused inside a word), else the bold with `__` under the same condition. Two `~~` never touch
 *   because same-style runs are merged and cut pieces are kept apart.
 * Null when no span reaches the selection (the plain wrap does it), for `code`, or when the cuts
 * cannot be made without crossing.
 */
function rewriteSpans(
  text: string,
  selStart: number,
  selEnd: number,
  kind: InlineKind,
  all: StyleSpan[],
  remove: boolean
): { from: number; to: number; text: string; first: number; last: number } | null {
  if (kind === 'code') return null;
  const style = wantedKind(kind) as Style;
  if (!all.some((sp) => reaches(sp, selStart, selEnd, style))) return null;
  let from = selStart;
  let to = selEnd;
  for (let grew = true; grew;) {
    grew = false;
    for (const sp of all) {
      if (reaches(sp, from, to, style) && (sp.start < from || sp.end > to)) {
        from = Math.min(from, sp.start);
        to = Math.max(to, sp.end);
        grew = true;
      }
    }
  }
  const inside = all.filter((sp) => !sp.kinds.includes('code') && from <= sp.start && sp.end <= to);
  const isMarker = (p: number) =>
    inside.some(
      (sp) => (p >= sp.start && p < sp.contentStart) || (p >= sp.contentEnd && p < sp.end)
    );
  const chars: Array<{ p: number; set: Set<Style> }> = [];
  for (let p = from; p < to; p++) {
    if (isMarker(p)) continue;
    const set = new Set<Style>();
    for (const sp of inside) {
      if (p >= sp.contentStart && p < sp.contentEnd) {
        for (const k of sp.kinds) if (k !== 'code') set.add(k);
      }
    }
    if (p >= selStart && p < selEnd) {
      if (remove) set.delete(style);
      else set.add(style);
    }
    chars.push({ p, set });
  }
  const selected = chars.flatMap((c, i) => (c.p >= selStart && c.p < selEnd ? [i] : []));
  if (selected.length === 0) return null;
  const space = (i: number) => /\s/.test(text[chars[i].p]);
  /** `[a, b)` with the whitespace at both ends cut off; null when nothing is left. */
  const trimmed = (st: Style, a: number, b: number): Run | null => {
    while (a < b && space(a)) a++;
    while (b > a && space(b - 1)) b--;
    return b > a ? { style: st, a, b } : null;
  };
  let runs: Run[] = [];
  for (const st of STYLE_ORDER) {
    let i = 0;
    while (i < chars.length) {
      if (!chars[i].set.has(st)) {
        i++;
        continue;
      }
      let j = i;
      while (j < chars.length && chars[j].set.has(st)) j++;
      const run = trimmed(st, i, j);
      if (run) runs.push(run);
      i = j;
    }
  }
  const crossing = (): [Run, Run] | null => {
    for (const x of runs) {
      for (const y of runs) {
        if (x.a < y.a && y.a < x.b && x.b < y.b) return [x, y];
      }
    }
    return null;
  };
  /** A cut at `c` leaves the two pieces touching when neither side of it is whitespace. */
  const abuts = (c: number) => !space(c - 1) && !space(c);
  for (let guard = 0; guard < 400; guard++) {
    const pair = crossing();
    if (!pair) break;
    const [x, y] = pair;
    // Cut the run of another style, not the one being applied, unless that cut would leave its
    // two pieces touching and the other would not.
    let victim = y;
    let at = x.b;
    let other = x;
    let otherAt = y.a;
    if (y.style === style && x.style !== style) {
      victim = x;
      at = y.a;
      other = y;
      otherAt = x.b;
    }
    if (abuts(at) && !abuts(otherAt)) {
      victim = other;
      at = otherAt;
    }
    const pieces = [trimmed(victim.style, victim.a, at), trimmed(victim.style, at, victim.b)];
    runs = runs.filter((r) => r !== victim);
    for (const piece of pieces) if (piece) runs.push(piece);
  }
  if (crossing()) return null;
  const rank = (st: Style) => STYLE_ORDER.indexOf(st);
  runs.sort((x, y) => x.a - y.a || y.b - x.b || rank(x.style) - rank(y.style));
  // The markers written at each boundary between two characters, in the order they are written.
  const boundary: Run[][] = Array.from({ length: chars.length + 1 }, () => []);
  const stack: Run[] = [];
  let next = 0;
  for (let i = 0; i <= chars.length; i++) {
    while (stack.length && stack[stack.length - 1].b === i) boundary[i].push(stack.pop()!);
    if (i === chars.length) break;
    while (next < runs.length && runs[next].a === i) {
      boundary[i].push(runs[next]);
      stack.push(runs[next++]);
    }
  }
  const wordy = (i: number) => {
    const p = i < 0 ? from - 1 : i >= chars.length ? to : chars[i].p;
    return p >= 0 && p < text.length && /[\p{L}\p{N}]/u.test(text[p]);
  };
  /** Underscore emphasis is refused inside a word: no letter or digit may touch the run outside. */
  const legal = (r: Run) => !wordy(r.a - 1) && !wordy(r.b);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const marks of boundary) {
      for (let k = 0; k + 1 < marks.length; k++) {
        const x = marks[k];
        const y = marks[k + 1];
        // Two markers of one character touch; so does a star marker with a `~~`: marked does not
        // compose a `**` or `*` that opens straight after, or closes straight before, a strike.
        const stars = [x, y].filter((r) => markChar(r) === '*').length;
        const clash =
          markChar(x) === markChar(y)
            ? markChar(x) !== '~'
            : stars === 1 && [x, y].some((r) => r.style === 'strike');
        if (!clash) continue;
        const pick =
          [x, y].find((r) => r.style === 'italic' && !r.under && legal(r)) ??
          [x, y].find((r) => r.style === 'bold' && !r.under && legal(r));
        if (pick) {
          pick.under = true;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  // The selection afterwards: the selected text, or - when the style was applied - the whole run
  // of the style it joined (`soir** demain` over `**Prix ce soir** demain` selects all of it).
  let lo = selected[0];
  let hi = selected[selected.length - 1];
  if (!remove) {
    for (const r of runs) {
      if (r.style === style && r.a <= selected[selected.length - 1] && r.b > selected[0]) {
        lo = Math.min(lo, r.a);
        hi = Math.max(hi, r.b - 1);
      }
    }
  }
  let out = '';
  let first = -1;
  let last = -1;
  for (let i = 0; i <= chars.length; i++) {
    const closing = boundary[i].filter((r) => r.b === i);
    const opening = boundary[i].filter((r) => r.a === i);
    for (const r of closing) {
      out += markOf(r);
      // A style that opened inside the selection closes inside it: its marker is selected too.
      if (!remove && i === hi + 1 && r.style !== style && r.a > lo) {
        last = out.length;
      }
    }
    if (i === chars.length) break;
    for (const r of opening) out += markOf(r);
    if (i === lo) first = out.length;
    out += text[chars[i].p];
    if (i === hi) last = out.length;
  }
  return { from, to, text: out, first, last };
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
  /** Every span of any style on that line. */
  all: StyleSpan[];
}

/**
 * A selection is "wholly inside the style" when every non-blank character of it that is not one of
 * the spans' own markers lies in the content of a span of the style.
 */
function coveringSpans(
  spans: StyleSpan[],
  start: number,
  end: number,
  text: string,
  all: StyleSpan[]
): StyleSpan[] | null {
  // The marker of ANY span is not text the selection must be inside the style for.
  const isMarker = (p: number) =>
    all.some((sp) => (p >= sp.start && p < sp.contentStart) || (p >= sp.contentEnd && p < sp.end));
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
 *   empty pieces dropped); anything else wraps the trimmed selection once. Whenever a span touches
 *   the selection the line is written from the model of `rewriteSpans` (a span the selection
 *   crosses an edge of joins it whole: `soir** demain` over `**Prix ce soir** demain` gives
 *   `**Prix ce soir demain**`); with no span, stray runs of the marker are stripped and the text
 *   wrapped.
 */
function formatInlineOnce(
  kind: InlineKind,
  text: string,
  selStart: number,
  selEnd: number,
  ph: FormatPlaceholders
): { result: FormatResult; direction: -1 | 0 | 1 } {
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
      const all = allSpans(line.text, line.start, prefix);
      // An edge inside the MARKER of a span of another style snaps to the text beside it.
      for (const sp of all) {
        if (sp.kinds.includes(wantedKind(kind)) || sp.kinds.includes('code')) continue;
        if (start > sp.start && start < sp.contentStart) start = sp.contentStart;
        if (end > sp.contentEnd && end < sp.end) end = sp.contentEnd;
      }
      while (start < end && /\s/.test(text[start])) start++;
      while (end > start && /\s/.test(text[end - 1])) end--;
      if (end <= start) continue;
      const spans = styleSpans(all, kind);
      segments.push({ start, end, covering: coveringSpans(spans, start, end, text, all), all });
    }
  }

  if (segments.length === 0) {
    // Nothing but whitespace, or nothing: a placeholder at the caret, past the line's block marker.
    const line = linesCovering(text, selStart, selStart)[0];
    const prefix = prefixLength(line.text);
    const at = Math.max(selEnd, line.start + prefix);
    const start = at + marker.length;
    return {
      result: {
        text: text.slice(0, at) + marker + placeholder + marker + text.slice(at),
        selStart: start,
        selEnd: start + placeholder.length,
      },
      direction: 0,
    };
  }

  const off = segments.every((s) => s.covering);
  const mixed = !off && segments.some((s) => s.covering);
  let out = '';
  let cursor = 0;
  let first = -1;
  let last = -1;
  for (const seg of segments) {
    if (seg.covering && mixed) {
      // Mixed selection: a line that already has the style keeps it.
      out += text.slice(cursor, seg.end);
      cursor = seg.end;
      continue;
    }
    const rewritten = rewriteSpans(text, seg.start, seg.end, kind, seg.all, off);
    if (rewritten) {
      out += text.slice(cursor, rewritten.from);
      first = first === -1 ? out.length + rewritten.first : first;
      last = out.length + rewritten.last;
      out += rewritten.text;
      cursor = rewritten.to;
      continue;
    }
    if (seg.covering) {
      // Code, the one style the model does not write: each span around the selection is split.
      for (const span of seg.covering) {
        out += text.slice(cursor, span.start);
        const from = Math.max(seg.start, span.contentStart);
        const to = Math.min(seg.end, span.contentEnd);
        out += wrapPiece(text.slice(span.contentStart, from), span.marker);
        first = first === -1 ? out.length : first;
        out += stripRuns(text.slice(from, to), kind);
        last = out.length;
        out += wrapPiece(text.slice(to, span.contentEnd), span.marker);
        cursor = span.end;
      }
      continue;
    }
    // No span reaches the selection: stray runs of the marker are taken out and the trimmed
    // selection is wrapped once. Whitespace a strip exposes stays outside.
    const body = text.slice(seg.start, seg.end);
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
  if (first === -1) {
    // Mixed selection where nothing was wrapped: the selection stays where it was.
    return { result: { text, selStart, selEnd }, direction: 0 };
  }
  return {
    result: { text: out + text.slice(cursor), selStart: first, selEnd: last },
    direction: off ? -1 : 1,
  };
}

const verifier = new Marked({ gfm: true, breaks: true });
const STYLE_BIT = { bold: 1, italic: 2, strikethrough: 4, code: 0 } as const;
const TAG_BIT: Record<string, number> = { strong: 1, em: 2, del: 4 };
const ENTITY: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** What marked draws: the styles over each visible character, and the marker characters left over. */
function renderedStyles(md: string): { bits: number[]; literal: number } {
  const html = verifier.parse(md, { async: false }) as string;
  const bits: number[] = [];
  const open: number[] = [];
  let code = 0;
  let literal = 0;
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>|([^<]+)/g)) {
    if (m[3] !== undefined) {
      const chars = m[3].replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITY[e]);
      if (code === 0) literal += (chars.match(/[*_~]/g) ?? []).length;
      const mask = open.reduce((a, b) => a | b, 0);
      for (const ch of chars) if (!/[\s*_~]/.test(ch)) bits.push(mask);
      continue;
    }
    const tag = m[2].toLowerCase();
    if (tag === 'pre' || tag === 'code') code += m[1] ? -1 : 1;
    else if (TAG_BIT[tag]) {
      if (m[1]) open.pop();
      else open.push(TAG_BIT[tag]);
    }
  }
  return { bits, literal };
}

/**
 * The paragraph (blocks are split at a blank line) an edit lives in, in `before` and in `after`:
 * marked is asked about that block only, never the whole document.
 */
function editedBlock(before: string, after: string): [string, string] {
  let a = 0;
  while (a < before.length && a < after.length && before[a] === after[a]) a++;
  let b = 0;
  while (
    b < before.length - a &&
    b < after.length - a &&
    before[before.length - 1 - b] === after[after.length - 1 - b]
  ) {
    b++;
  }
  const lead = before.lastIndexOf('\n\n', Math.max(0, a - 1));
  const start = lead === -1 ? 0 : lead + 2;
  const tail = before.indexOf('\n\n', before.length - b);
  const endBefore = tail === -1 ? before.length : tail;
  const endAfter = endBefore + (after.length - before.length);
  return [before.slice(start, endBefore), after.slice(start, endAfter)];
}

/**
 * True when marked draws `after` as the action promised relative to `before`, over the edited block:
 * no marker character left showing that was not showing already, every visible character keeps every
 * style but the one toggled, that style changes only inside a window as wide as the `selected`
 * characters, and it reaches more characters (`direction` 1) or fewer (-1).
 * A render that throws is a failure, never an approval.
 */
function rendersAsPromised(
  kind: InlineKind,
  before: string,
  after: string,
  direction: -1 | 1,
  selected: number
): boolean {
  try {
    const [was, is] = editedBlock(before, after);
    const a = renderedStyles(was);
    const b = renderedStyles(is);
    if (b.literal > a.literal || a.bits.length !== b.bits.length) return false;
    const mine = STYLE_BIT[kind];
    let had = 0;
    let has = 0;
    let lo = -1;
    let hi = -1;
    for (let i = 0; i < a.bits.length; i++) {
      if (((a.bits[i] ^ b.bits[i]) & ~mine) !== 0) return false;
      if (a.bits[i] & mine) had++;
      if (b.bits[i] & mine) has++;
      if ((a.bits[i] ^ b.bits[i]) & mine) {
        if (lo === -1) lo = i;
        hi = i;
      }
    }
    // The toggled style may change only where the selection is: its changes fit in a window as
    // wide as the selected characters.
    if (lo !== -1 && hi - lo + 1 > selected) return false;
    return direction > 0 ? has > had : has < had;
  } catch (error) {
    console.warn('[toolbar] marked threw while judging an inline action, so it is refused', error);
    return false;
  }
}

/** The marker characters and the spacing around a selection, every letter blanked: no content. */
function shapeAround(text: string, selStart: number, selEnd: number): string {
  const blank = (s: string) => s.replace(/[^\s*_~`]/gu, 'x');
  return `${blank(text.slice(Math.max(0, selStart - 8), selStart))}[${blank(text.slice(selStart, selEnd).slice(0, 24))}]${blank(text.slice(selEnd, selEnd + 8))}`;
}

/**
 * The inline action, KEPT only if marked draws it as promised (`rendersAsPromised`, on the edited
 * block). If not, NOTHING is written: the text comes back unchanged, no error is shown, and an
 * accusing line names the shape (style, selection length, the markers around it - never the text),
 * because writing a style that renders as stray asterisks is worse than not writing it. The spelling
 * rules of `rewriteSpans` exist so that this refusal is (nearly) never taken.
 */
function formatInline(
  kind: InlineKind,
  text: string,
  selStart: number,
  selEnd: number,
  ph: FormatPlaceholders
): FormatResult {
  const { result, direction } = formatInlineOnce(kind, text, selStart, selEnd, ph);
  if (kind === 'code' || direction === 0) return result;
  const visible = text.slice(selStart, selEnd).replace(/[\s*_~]/gu, '').length;
  if (rendersAsPromised(kind, text, result.text, direction, visible)) return result;
  console.warn(
    `[toolbar] REFUSED ${kind} ${direction > 0 ? 'on' : 'off'}: marked would not draw it as promised; ` +
      `selection ${selEnd - selStart} chars, shape ${shapeAround(text, selStart, selEnd)}`
  );
  return { text, selStart, selEnd, refused: true };
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
  if (result.refused) {
    // The text stays as it is; the member is told, and the console already counted the shape.
    showToast(m.md_toolbar_refused(), 'warning');
    return;
  }

  setText(result.text);
  await tick();
  composer.focusEditor();
  composer.setSelectionRange(result.selStart, result.selEnd);
}
