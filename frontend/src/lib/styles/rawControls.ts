/**
 * THE SCANNER BEHIND THE CONTROLS GUARD (`controlsGuard.test.ts`): which hand-built buttons, selects
 * and text fields does a Svelte file contain.
 *
 * A "raw control" is a `<button>`, a `<select>`, or an `<input>` that draws a TEXT field (no `type`,
 * a dynamic `type`, or one of text / email / password / search / tel / url / number) written in
 * markup instead of through `Button`, `Select` / `Picker` or `Input`. Checkboxes, radios, files,
 * ranges, colours and the date family are not text fields and are never counted.
 *
 * The tag is read by WALKING it, not matched: `onclick={() => a > b}` carries a `>` inside an
 * attribute expression, and a `[^>]*` regex would end the tag there and miscount its attributes.
 * Comments are stripped first, so a docblock explaining the rule is never the thing that trips it.
 *
 * Test-only: no runtime code reads its own source.
 */
import { withoutAnyComments } from './markupSources';

/** What was found in one file. */
export interface RawControlCounts {
  button: number;
  select: number;
  input: number;
}

/** Input types that are NOT a text field: the platform's own widget is the right one. */
const NON_TEXT_INPUT = new Set([
  'checkbox',
  'radio',
  'file',
  'hidden',
  'range',
  'color',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'submit',
  'button',
  'reset',
  'image',
]);

/** The attribute text of the tag whose name ends at `from`, read up to its closing `>`. */
function tagAttributes(source: string, from: number): string {
  let depth = 0;
  let quote = '';
  for (let i = from; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '{') {
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
    } else if (c === '>' && depth <= 0) {
      return source.slice(from, i);
    }
  }
  return source.slice(from);
}

/** The static `type` of an input's attributes, or `''` when absent or dynamic. */
function staticInputType(attributes: string): string {
  const match = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes);
  return (match?.[1] ?? match?.[2] ?? '').toLowerCase();
}

/** Counts the raw controls in one file's text. */
export function rawControlsIn(text: string): RawControlCounts {
  const source = withoutAnyComments(text);
  const counts: RawControlCounts = { button: 0, select: 0, input: 0 };
  const open = /<(button|select|input)(?=[\s/>])/g;
  for (let match = open.exec(source); match; match = open.exec(source)) {
    const name = match[1] as keyof RawControlCounts;
    if (name === 'input') {
      const attributes = tagAttributes(source, open.lastIndex);
      if (NON_TEXT_INPUT.has(staticInputType(attributes))) continue;
    }
    counts[name] += 1;
  }
  return counts;
}

/** The sum of the three kinds. */
export function totalRawControls(counts: RawControlCounts): number {
  return counts.button + counts.select + counts.input;
}
