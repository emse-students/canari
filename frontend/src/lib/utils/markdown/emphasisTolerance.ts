import { Marked } from 'marked';
import { urlLengthAt, urlMayStartAt } from './markdownText';

/**
 * THE RENDERER'S HALF OF THE MARKDOWN-COHERENCE FIX (`docs/wiki/frontend/markdown-coherence.md`).
 *
 * A double marker with whitespace just inside it - `**TOP 5 MINIMOYS **`, `** x**`, `~~ gone ~~` -
 * is refused by CommonMark (a closing run after whitespace is not right-flanking), so a post written
 * with the old toolbar showed literal asterisks while the composer preview showed bold. This moves
 * the whitespace OUTSIDE the markers before the renderer sees the text.
 *
 * THE RULE, TRUE BY CONSTRUCTION: no post that rendered a bold correctly before may render
 * differently after. Nothing here PREDICTS what marked will do. Per paragraph, the paragraph is
 * rendered as it is today; only when that render still shows a literal `**`, `__` or `~~` is a
 * rewrite tried, one loose span at a time, and a span is kept only if the new render (a) still
 * holds every strong, em and del run of the original render, with the same text at the same
 * nesting depth or deeper, and (b) shows strictly fewer literal markers. Anything else keeps the
 * original text. A paragraph with no leftover marker, the normal case, costs one extra render.
 *
 * Bounded so that it is safe on any input: a paragraph over `MAX_PARAGRAPH` characters is left
 * alone, at most `MAX_CANDIDATES` spans are tried per paragraph, and a document may spend
 * `DOCUMENT_BUDGET` rendered characters in all. Each falls back to the original text, which cannot
 * lose anything.
 */

/** Same options `PostMarkdown` hands svelte-markdown. */
const parser = new Marked({ gfm: true, breaks: true });

const MAX_PARAGRAPH = 8000;
const MAX_CANDIDATES = 24;
/**
 * Characters the tolerance may render per DOCUMENT (one render of a paragraph costs its length).
 * Deterministic, unlike a clock: past it the rest of the document is left exactly as written, which
 * cannot lose anything. Sized for about forty renders of the longest paragraph.
 */
const DOCUMENT_BUDGET = 300_000;

/** What is left of a document's budget, shared by its paragraphs. */
interface Budget {
  left: number;
}

/** One emphasis element of a rendered paragraph. */
export interface EmphasisRun {
  tag: 'strong' | 'em' | 'del';
  /** Its text, whitespace collapsed and trimmed (for messages; identity is `start` and `length`). */
  text: string;
  /** How many emphasis elements enclose it. */
  depth: number;
  /** Where it starts, in rendered characters that are not whitespace and not `*`, `_` or `~`. */
  start: number;
  /** How many such characters it holds. */
  length: number;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
const decode = (s: string): string => s.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
const norm = (s: string): string => decode(s).replace(/\s+/g, ' ').trim();
/** What counts toward a run's offset: the letters, digits and punctuation a reader sees. */
const countable = (s: string): number => decode(s).replace(/[\s*_~]/gu, '').length;

/**
 * Reads a rendered paragraph: its emphasis runs, and how many literal `**`, `__` or `~~` its text
 * still shows (code excluded, where they are meant). A tag scanner, not a DOM: it runs wherever the
 * preprocessing does. A run is located by where it starts among the countable characters, so two
 * runs with the same text are two runs and a rewrite cannot move one onto another.
 */
export function analyseRendered(html: string): { runs: EmphasisRun[]; literal: number } {
  const runs: EmphasisRun[] = [];
  const open: Array<{ tag: EmphasisRun['tag']; text: string; depth: number; start: number }> = [];
  let literal = 0;
  let code = 0;
  let pos = 0;
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(html)) !== null) {
    if (m[3] !== undefined) {
      if (code === 0) literal += m[3].match(/\*\*|__|~~/g)?.length ?? 0;
      for (const el of open) el.text += m[3];
      pos += countable(m[3]);
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (tag === 'pre' || tag === 'code') {
      code += closing ? -1 : 1;
    } else if (tag === 'strong' || tag === 'em' || tag === 'del') {
      if (closing) {
        const el = open.pop();
        if (el) {
          runs.push({
            tag: el.tag,
            text: norm(el.text),
            depth: el.depth,
            start: el.start,
            length: pos - el.start,
          });
        }
      } else {
        open.push({ tag, text: '', depth: open.length, start: pos });
      }
    }
  }
  return { runs, literal };
}

/**
 * True when every run of `original` is still in `candidate`: the same tag over the same stretch
 * of text (same start, same length), at the same nesting depth or deeper.
 */
export function preservesRuns(original: EmphasisRun[], candidate: EmphasisRun[]): boolean {
  const pool = new Map<string, number[]>();
  const keyOf = (r: EmphasisRun) => `${r.tag}|${r.start}|${r.length}`;
  for (const run of candidate) {
    const key = keyOf(run);
    const depths = pool.get(key);
    if (depths) depths.push(run.depth);
    else pool.set(key, [run.depth]);
  }
  for (const run of original) {
    const depths = pool.get(keyOf(run));
    if (!depths) return false;
    depths.sort((a, b) => a - b);
    const at = depths.findIndex((d) => d >= run.depth);
    if (at === -1) return false;
    depths.splice(at, 1);
  }
  return true;
}

/** Ranges `[start, end)` of `line` that emphasis never reaches: code spans and autolinked URLs. */
function protectedRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '`') {
      let run = 1;
      while (line[i + run] === '`') run++;
      // The span closes on a run of EXACTLY the same length (``a`b`` holds a backtick).
      let j = i + run;
      let close = -1;
      while (j < line.length) {
        if (line[j] !== '`') {
          j++;
          continue;
        }
        let r = 1;
        while (line[j + r] === '`') r++;
        if (r === run) {
          close = j + r;
          break;
        }
        j += r;
      }
      if (close === -1) {
        i += run;
      } else {
        ranges.push([i, close]);
        i = close;
      }
      continue;
    }
    const url = urlMayStartAt(line, i) ? urlLengthAt(line, i) : 0;
    if (url > 0) {
      ranges.push([i, i + url]);
      i += url;
      continue;
    }
    i++;
  }
  return ranges;
}

/** A double marker with whitespace inside it, on one line, whose inside holds no marker. */
const LOOSE_RE = /(?<![\\*_~])(\*\*\*|\*\*|__|~~)((?:(?!\1)[^\n])+?)\1(?![*_~])/gu;

interface Candidate {
  start: number;
  end: number;
  replacement: string;
}

/** The loose spans of one paragraph, as edits on it. The moved space is never doubled. */
function looseCandidates(paragraph: string): Candidate[] {
  const candidates: Candidate[] = [];
  let lineStart = 0;
  for (const line of paragraph.split('\n')) {
    const prose: Array<[number, number]> = [];
    let cursor = 0;
    for (const [start, end] of protectedRanges(line)) {
      prose.push([cursor, start]);
      cursor = end;
    }
    prose.push([cursor, line.length]);
    for (const [from, to] of prose) {
      const re = new RegExp(LOOSE_RE.source, LOOSE_RE.flags);
      const text = line.slice(from, to);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const [whole, marker, inner] = m;
        const lead = /^[ \t]*/.exec(inner)?.[0] ?? '';
        const trail = /[ \t]*$/.exec(inner)?.[0] ?? '';
        if (!lead && !trail) continue; // already plain CommonMark
        const start = lineStart + from + m.index;
        const end = start + whole.length;
        // Dropped next to existing whitespace or a line edge: widening a list item's content
        // (`- ** item **`) would change what the line IS.
        const before = lead && start > 0 && !/\s/.test(paragraph[start - 1]) ? ' ' : '';
        const after = trail && end < paragraph.length && !/\s/.test(paragraph[end]) ? ' ' : '';
        candidates.push({
          start,
          end,
          replacement: `${before}${marker}${inner.trim()}${marker}${after}`,
        });
      }
    }
    lineStart += line.length + 1;
  }
  return candidates.slice(0, MAX_CANDIDATES);
}

/** Renders `markdown`, or null when the document budget cannot pay for it. */
function render(markdown: string, budget: Budget): string | null {
  if (budget.left < markdown.length) return null;
  budget.left -= markdown.length;
  return parser.parse(markdown, { async: false }) as string;
}

/** One paragraph (no blank line, no code): the rewrite that loses nothing, or the paragraph. */
function tolerateParagraph(paragraph: string, budget: Budget): string {
  if (paragraph.length > MAX_PARAGRAPH || !/\*\*|__|~~/.test(paragraph)) return paragraph;
  try {
    const first = render(paragraph, budget);
    if (first === null) return paragraph;
    const original = analyseRendered(first);
    if (original.literal === 0) return paragraph;
    let current = paragraph;
    let literal = original.literal;
    // Right to left, so an accepted edit never shifts the offsets of the ones still to try.
    for (const c of looseCandidates(paragraph).reverse()) {
      const next = current.slice(0, c.start) + c.replacement + current.slice(c.end);
      const html = render(next, budget);
      if (html === null) break; // budget spent: what was accepted so far is already safe
      const seen = analyseRendered(html);
      if (seen.literal < literal && preservesRuns(original.runs, seen.runs)) {
        current = next;
        literal = seen.literal;
      }
    }
    return current;
  } catch {
    return paragraph;
  }
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;

/**
 * Moves the whitespace just inside a double emphasis marker OUTSIDE it, so `**TOP 5 MINIMOYS **`
 * renders bold like the composer preview shows it, without ever changing a paragraph that rendered
 * its emphasis (see the file header for the rule and how it is enforced).
 *
 * Never touched: fenced code (``` and ~~~, at any indent, since a list item may hold one) and
 * 4-space indented code outside a list. Paragraphs are the blocks between blank lines.
 */
export function tolerateEmphasisWhitespace(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  const budget: Budget = { left: DOCUMENT_BUDGET };
  let group: string[] = [];
  const flush = () => {
    if (group.length) out.push(...tolerateParagraph(group.join('\n'), budget).split('\n'));
    group = [];
  };
  let fence: string | null = null;
  let inList = false;
  let prevBlank = true;
  let prevIndentedCode: boolean = false;
  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = null;
      }
      out.push(line);
      continue;
    }
    if (fenceMatch) {
      flush();
      fence = fenceMatch[1];
      prevBlank = false;
      out.push(line);
      continue;
    }
    const blank = line.trim() === '';
    const indented = /^(?: {4,}|\t)/.test(line);
    if (!blank && LIST_ITEM_RE.test(line)) inList = true;
    else if (!blank && !indented && prevBlank) inList = false;
    const isCode: boolean = !blank && indented && !inList && (prevBlank || prevIndentedCode);
    prevIndentedCode = isCode || (blank && prevIndentedCode);
    prevBlank = blank;
    if (blank || isCode) {
      flush();
      out.push(line);
    } else {
      group.push(line);
    }
  }
  flush();
  return out.join('\n');
}
