import { FENCE_CLOSE_LINE_RE, FENCE_OPEN_LINE_RE } from './inlinePreview';

/**
 * A double marker with whitespace just inside it: `**TOP 5 **`, `** x**`, `~~ gone ~~`.
 * CommonMark refuses these (a closing run preceded by whitespace is not right-flanking), so the
 * author sees bold in the composer preview and literal asterisks in the published post. The
 * lookbehind keeps a match from starting inside a longer run or after an escape.
 */
const LOOSE_DOUBLE_MARKER_RE =
  /(?<![\\*_~])(\*\*\*|\*\*|__|~~)([ \t]*)(\S(?:[^\n]*?\S)?)([ \t]*)\1(?![*_~])/g;

/** Splits a line into [text, codeSpan, text, ...] so a code span is never rewritten. */
function splitCodeSpans(line: string): string[] {
  return line.split(/(`[^`\n]+`)/);
}

function tolerateLine(line: string): string {
  return splitCodeSpans(line)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(
            LOOSE_DOUBLE_MARKER_RE,
            (whole, marker: string, before: string, inner: string, after: string) =>
              before || after ? `${before}${marker}${inner}${marker}${after}` : whole
          )
    )
    .join('');
}

/**
 * Moves the whitespace just inside a double emphasis marker OUTSIDE it, so `**TOP 5 MINIMOYS **`
 * renders bold like the composer preview already showed it. This is the renderer's half of the
 * markdown-coherence fix (the toolbar's half is `composerMarkdownFormat.ts`, which never writes
 * such text): posts published before the toolbar was fixed keep their asterisks in the database.
 *
 * Single `*` / `_` are left alone on purpose: `2 * 3 * 4` is arithmetic, and the preview
 * (`inlinePreview.ts`) applies strict CommonMark flanking to them too, so both agree. Fenced code
 * blocks and inline code spans are never touched.
 */
export function tolerateEmphasisWhitespace(md: string): string {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (!inFence && FENCE_OPEN_LINE_RE.test(line)) {
        inFence = true;
        return line;
      }
      if (inFence) {
        if (FENCE_CLOSE_LINE_RE.test(line)) inFence = false;
        return line;
      }
      return tolerateLine(line);
    })
    .join('\n');
}
