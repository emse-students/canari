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

/**
 * A fence OPENER: three or more backticks or tildes, then an info string. A backtick fence whose info
 * string holds a backtick is no fence (CommonMark): "```x``` voir" is a line of text with a code
 * span, and must not swallow the rest of the post as a block.
 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A fence CLOSER: fence characters and nothing else but white space. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
/** A list item's marker and the space after it: its width is where the item's content starts. */
const LIST_ITEM_RE = /^( {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+)\S/;

/** A line's indentation in columns, a tab counting to the next multiple of four. */
function indentOf(line: string): number {
  let column = 0;
  for (const char of line) {
    if (char === ' ') column += 1;
    else if (char === '\t') column += 4 - (column % 4);
    else break;
  }
  return column;
}

/** The fence a line opens, or null. */
function fenceOpened(line: string): { char: string; length: number } | null {
  const open = line.match(FENCE_OPEN_RE);
  if (!open) return null;
  if (open[1][0] === '`' && open[2].includes('`')) return null;
  return { char: open[1][0], length: open[1].length };
}

/**
 * Which LINES of `text` belong to a fenced or indented code block, fence lines included.
 *
 * An indented block needs four columns MORE than the content of the list item it sits in: under
 * "- item", a line indented by four after a blank line continues the item (a paragraph of it, read
 * as text, its URL a link), and only eight columns make it code - CommonMark's reading, the one the
 * renderer draws.
 *
 * @returns One boolean per line, in the order `text.split(/\r?\n/)` gives them.
 */
export function codeBlockLines(text: string): boolean[] {
  const lines = linesOf(text).map((l) => l.line);
  const out: boolean[] = [];
  let fence: { char: string; length: number } | null = null;
  let previousBlank = true;
  let inIndented = false;
  // The column where the current list item's content starts; 0 outside a list.
  let listContent = 0;
  for (const line of lines) {
    if (fence) {
      out.push(true);
      const close = line.match(FENCE_CLOSE_RE);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      previousBlank = false;
      continue;
    }
    const opened = fenceOpened(line);
    if (opened) {
      fence = opened;
      out.push(true);
      inIndented = false;
      previousBlank = false;
      continue;
    }
    const blank = line.trim() === '';
    if (blank) {
      // A blank line inside an indented block keeps it open for the next indented line.
      out.push(inIndented);
      previousBlank = true;
      continue;
    }
    const indent = indentOf(line);
    // After a blank line, a line left of the item's content ends the list.
    if (previousBlank && indent < listContent) listContent = 0;
    if (indent >= listContent + 4 && (previousBlank || inIndented)) {
      inIndented = true;
      out.push(true);
    } else {
      inIndented = false;
      const item = line.match(LIST_ITEM_RE);
      if (item) listContent = indentOf(item[1].replace(/\S/g, ' '));
      out.push(false);
    }
    previousBlank = false;
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
