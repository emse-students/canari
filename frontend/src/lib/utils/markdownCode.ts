/**
 * WHERE A MARKDOWN TEXT IS CODE, so that what a reader typed as code is never read as a link: no
 * preview card for a URL in a code span or a code block (`extractPreviewUrls`), and no URL taken out
 * of one (`stripCardedUrls`).
 *
 * The three CommonMark code constructs a post or a message uses: a fenced block (three or more
 * backticks or tildes, closed by a fence of the same character at least as long, or running to the
 * end of the text when never closed), an indented block (lines indented by four spaces or a tab,
 * after a blank line or at the start), and an inline code span (a run of backticks closed by a run of
 * the same length). Lines may end in `\n` or `\r\n`.
 */

/** A half-open `[start, end)` range of character offsets. */
export type CodeRange = readonly [number, number];

/** The lines of `text` with their start offsets, the line terminator excluded. */
function linesOf(text: string): { line: string; start: number }[] {
  const out: { line: string; start: number }[] = [];
  const re = /\r?\n/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.push({ line: text.slice(start, match.index), start });
    start = match.index + match[0].length;
  }
  out.push({ line: text.slice(start), start });
  return out;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INDENTED_RE = /^(?: {4}|\t)/;

/**
 * Which LINES of `text` belong to a fenced or indented code block, fence lines included.
 *
 * @returns One boolean per line, in the order `text.split(/\r?\n/)` gives them.
 */
export function codeBlockLines(text: string): boolean[] {
  const lines = linesOf(text).map((l) => l.line);
  const out: boolean[] = [];
  let fence: { char: string; length: number } | null = null;
  let previousBlank = true;
  let inIndented = false;
  for (const line of lines) {
    if (fence) {
      out.push(true);
      const close = line.match(FENCE_RE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      previousBlank = false;
      continue;
    }
    const open = line.match(FENCE_RE);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      out.push(true);
      inIndented = false;
      previousBlank = false;
      continue;
    }
    const blank = line.trim() === '';
    if (!blank && INDENTED_RE.test(line) && (previousBlank || inIndented)) {
      inIndented = true;
      out.push(true);
    } else {
      // A blank line inside an indented block keeps it open for the next indented line.
      if (!blank) inIndented = false;
      out.push(false);
    }
    previousBlank = blank;
  }
  return out;
}

/** The inline code spans of ONE line (outside blocks), as offsets into that line. */
function codeSpansOf(line: string): CodeRange[] {
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, length: m[0].length }));
  const spans: CodeRange[] = [];
  let i = 0;
  while (i < runs.length) {
    // The closer is the next run of EXACTLY the same length; an opener with none is literal.
    const j = runs.findIndex((run, k) => k > i && run.length === runs[i].length);
    if (j === -1) {
      i += 1;
      continue;
    }
    spans.push([runs[i].at, runs[j].at + runs[j].length]);
    i = j + 1;
  }
  return spans;
}

/** Every range of `text` that is code: whole block lines and inline spans. */
export function codeRanges(text: string): CodeRange[] {
  const lines = linesOf(text);
  const inBlock = codeBlockLines(text);
  const ranges: CodeRange[] = [];
  lines.forEach(({ line, start }, i) => {
    if (inBlock[i]) ranges.push([start, start + line.length]);
    else for (const [a, b] of codeSpansOf(line)) ranges.push([start + a, start + b]);
  });
  return ranges;
}

/** Whether the offset `at` falls inside one of `ranges`. */
export function insideCode(ranges: readonly CodeRange[], at: number): boolean {
  return ranges.some(([a, b]) => at >= a && at < b);
}
