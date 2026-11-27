/**
 * The piece of a message a result row shows: the words around the first match, and where every typed
 * word sits in that piece so the row can highlight it. Offsets are in the ORIGINAL text, mapped back
 * through `foldWithIndex`, so an accent before a match never shifts the highlight.
 */
import { foldWithIndex } from '$lib/utils/textFold';
import type { FoldedQuery } from './rank';

/** Characters kept on each side of the first match before the piece is cut. */
const CONTEXT = 48;

export interface Snippet {
  text: string;
  ranges: [number, number][];
}

/** The snippet of `text` for `query`; the start of the text when no word is found. */
export function snippetAround(text: string, query: FoldedQuery): Snippet {
  const flat = text.replace(/\s+/g, ' ').trim();
  const { folded, sourceIndex } = foldWithIndex(flat);
  const found: [number, number][] = [];
  for (const token of query.tokens) {
    let from = folded.indexOf(token);
    while (from !== -1) {
      found.push([sourceIndex[from], sourceIndex[from + token.length]]);
      from = folded.indexOf(token, from + token.length);
    }
  }
  found.sort((a, b) => a[0] - b[0]);
  const first = found.length > 0 ? found[0][0] : 0;
  const start = Math.max(0, first - CONTEXT);
  const end = Math.min(flat.length, Math.max(first + CONTEXT * 2, start + CONTEXT * 3));
  const prefix = start > 0 ? '\u2026' : '';
  const suffix = end < flat.length ? '\u2026' : '';
  const shift = prefix.length - start;
  const ranges = found
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]): [number, number] => [a + shift, b + shift]);
  return { text: `${prefix}${flat.slice(start, end)}${suffix}`, ranges: mergeRanges(ranges) };
}

/** Overlapping or touching ranges joined, so a highlight is never drawn twice over a letter. */
function mergeRanges(ranges: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}
