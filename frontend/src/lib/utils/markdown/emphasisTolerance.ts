/**
 * THE RENDERER'S HALF OF THE MARKDOWN-COHERENCE FIX (`docs/wiki/frontend/markdown-coherence.md`).
 *
 * A double marker with whitespace just inside it - `**TOP 5 MINIMOYS **`, `** x**`, `~~ gone ~~` -
 * is refused by CommonMark (a closing run after whitespace is not right-flanking), so a post written
 * with the old toolbar showed literal asterisks while the composer preview showed bold. This moves
 * the whitespace OUTSIDE the markers before marked sees the text.
 *
 * THE RULE THAT BOUNDS IT: no post that rendered a bold correctly before may render differently
 * after. A loose span is therefore rewritten only when it cannot be a stray marker stealing a real
 * one (`looseSpanAccepted`), and `markdownParity.test.ts` asserts the rule over a fuzzed corpus.
 * Single `*` / `_` are never tolerated (`2 * 3 * 4` is arithmetic).
 */

const WORD_OR_MARKER = /[*_~\p{L}\p{N}]/u;
const WORD = /[\p{L}\p{N}]/u;

/** A URL the renderer autolinks: markers inside it belong to the address, not to emphasis. */
export const URL_AT_RE = /^(?:https?:\/\/|www\.)\S+/u;

/** True when `ch` is a letter or a digit. */
export const isWordChar = (ch: string | undefined): boolean => !!ch && WORD.test(ch);

/** Counts `marker` occurrences in `s` that are not part of a longer run and not escaped. */
function countMarkers(s: string, marker: string, flank: 'closer' | 'opener'): number {
  const ch = marker[0];
  let n = 0;
  for (let i = 0; i <= s.length - marker.length; i++) {
    if (!s.startsWith(marker, i) || s[i - 1] === '\\') continue;
    if (s[i - 1] === ch || s[i + marker.length] === ch) {
      i += marker.length - 1;
      continue;
    }
    const before = s[i - 1];
    const after = s[i + marker.length];
    if (flank === 'closer' ? before && !/\s/.test(before) : after && !/\s/.test(after)) n++;
    i += marker.length - 1;
  }
  return n;
}

/**
 * Whether the span `text[openIdx .. closeIdx + marker.length)` may be read as emphasis although
 * whitespace touches the inside of a marker. Shared with the composer preview, so the two cannot
 * pair differently. A span with no whitespace inside is plain CommonMark and always accepted.
 *
 * Rejected, because it would be a stray marker and not an emphasis:
 * - the inside contains the marker (`5 ** 2 ... **important**`);
 * - the closer is glued to a letter, digit or marker (`x ** y **bold**`);
 * - a `__` opener sits inside a word (`foo__ bar__`);
 * - more real closers follow than real openers, so the first of them would have closed OUR opener
 *   in the renderer (`foo **bar ** baz** qux` is bold from `bar` to `baz` today and stays so).
 */
export function looseSpanAccepted(
  text: string,
  openIdx: number,
  closeIdx: number,
  marker: string
): boolean {
  const content = text.slice(openIdx + marker.length, closeIdx);
  if (content.trim() === '') return false;
  if (!/^\s|\s$/.test(content)) return true;
  if (content.includes(marker)) return false;
  const after = text[closeIdx + marker.length];
  if (after && WORD_OR_MARKER.test(after)) return false;
  if (marker.startsWith('_') && isWordChar(text[openIdx - 1])) return false;
  // Bounded: a pathological line of thousands of stray markers must not cost a quadratic scan.
  const rest = text.slice(closeIdx + marker.length, closeIdx + marker.length + 1500);
  return countMarkers(rest, marker, 'closer') <= countMarkers(rest, marker, 'opener');
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
    const urlStart = i === 0 || /[\s(]/.test(line[i - 1]);
    const url = urlStart ? URL_AT_RE.exec(line.slice(i)) : null;
    if (url) {
      ranges.push([i, i + url[0].length]);
      i += url[0].length;
      continue;
    }
    i++;
  }
  return ranges;
}

const LOOSE_RE = /(?<![\\*_~])(\*\*\*|\*\*|__|~~)((?:(?!\1)[^\n])+?)\1(?![*_~])/gu;

/** Rewrites the loose spans of one stretch of prose (no code, no URL). */
function tolerateProse(text: string): string {
  let out = '';
  let last = 0;
  const re = new RegExp(LOOSE_RE.source, LOOSE_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [whole, marker, inner] = m;
    const start = m.index;
    const lead = /^[ \t]*/.exec(inner)?.[0] ?? '';
    const trail = /[ \t]*$/.exec(inner)?.[0] ?? '';
    const closeIdx = start + marker.length + inner.length;
    if (!lead && !trail) continue; // already plain CommonMark: leave the span alone
    if (!looseSpanAccepted(text, start, closeIdx, marker)) {
      // Resume AFTER its closer: that marker may be the real closer of an earlier opener, and
      // reading it as a new opener is how `foo **bar ** baz** qux` would lose its bold.
      re.lastIndex = closeIdx + marker.length;
      continue;
    }
    const end = start + whole.length;
    // The moved space is dropped next to existing whitespace or a line edge: widening a list
    // item's content (`- ** item **`) would change what the line IS.
    const before = lead && start > 0 && !/\s/.test(text[start - 1]) ? ' ' : '';
    const after = trail && end < text.length && !/\s/.test(text[end]) ? ' ' : '';
    out += `${text.slice(last, start)}${before}${marker}${inner.trim()}${marker}${after}`;
    last = end;
  }
  return out + text.slice(last);
}

function tolerateLine(line: string): string {
  let out = '';
  let cursor = 0;
  for (const [start, end] of protectedRanges(line)) {
    out += tolerateProse(line.slice(cursor, start)) + line.slice(start, end);
    cursor = end;
  }
  return out + tolerateProse(line.slice(cursor));
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;

/**
 * Moves the whitespace just inside a double emphasis marker OUTSIDE it, so `**TOP 5 MINIMOYS **`
 * renders bold like the composer preview shows it.
 *
 * Never touched: fenced code (``` and ~~~, at any indent, since a list item may hold one), 4-space
 * indented code outside a list, inline code spans (matched by run length) and autolinked URLs.
 */
export function tolerateEmphasisWhitespace(md: string): string {
  let fence: string | null = null;
  let inList = false;
  let prevBlank = true;
  let prevIndentedCode = false;
  return md
    .split('\n')
    .map((line) => {
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
        return line;
      }
      if (fenceMatch) {
        fence = fenceMatch[1];
        prevBlank = false;
        return line;
      }
      const blank = line.trim() === '';
      const indented = /^(?: {4,}|\t)/.test(line);
      if (!blank && LIST_ITEM_RE.test(line)) inList = true;
      else if (!blank && !indented && prevBlank) inList = false;
      const isCode = !blank && indented && !inList && (prevBlank || prevIndentedCode);
      prevIndentedCode = isCode || (blank && prevIndentedCode);
      prevBlank = blank;
      return isCode ? line : tolerateLine(line);
    })
    .join('\n');
}
