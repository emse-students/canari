import { describe, expect, it } from 'vitest';
import { relativeTo, sourceFiles } from '../../test/sourceTree';

/**
 * A SLIDER SAYS WHAT IT SETS. A `<input type="range">` has no text of its own: without a name a
 * screen reader announces "slider, 40" and nothing else, and the caption drawn beside it helps only
 * someone who can see the two together. Nothing renders differently when the name is missing, so
 * the sources are read: every range input is inside a `<label>`, or carries `aria-label` /
 * `aria-labelledby`, or an `id` a `<label for>` of the same file points at.
 */

const SOURCES = sourceFiles({
  under: 'src',
  extensions: ['svelte'],
  tests: 'exclude',
  skipDirs: ['proto', 'paraglide'],
}).map(({ path, text }) => ({ file: relativeTo(path, 'src'), text }));

/**
 * Every `<input ...>` tag of `text` whose attributes include `type="range"`, with where it starts.
 * The tag ends at the first `>` OUTSIDE a `{...}` expression: a handler written inline holds one
 * (`oninput={(e) => ...}`), and stopping there would cut the attributes that follow it.
 */
function rangeInputs(text: string): { tag: string; index: number }[] {
  const found: { tag: string; index: number }[] = [];
  for (const { index } of text.matchAll(/<input\b/g)) {
    let depth = 0;
    let end = index;
    for (; end < text.length; end++) {
      const char = text[end];
      if (char === '{') depth++;
      else if (char === '}') depth--;
      else if (char === '>' && depth === 0) break;
    }
    const tag = text.slice(index, end + 1);
    if (/\btype="range"/.test(tag)) found.push({ tag, index });
  }
  return found;
}

/** Whether the range input `tag`, found at `at` in `text`, is named. */
function isNamed(text: string, tag: string, at: number): boolean {
  if (/\baria-label(?:ledby)?=/.test(tag)) return true;
  const id = /\bid="([^"{]+)"/.exec(tag)?.[1];
  if (id && text.includes(`for="${id}"`)) return true;
  const before = text.slice(0, at);
  const opened = before.split('<label').length - 1;
  const closed = before.split('</label>').length - 1;
  return opened > closed;
}

/** Every unnamed range input of `text`, as the line it starts on. */
function unnamedIn(text: string): number[] {
  return rangeInputs(text)
    .filter(({ tag, index }) => !isNamed(text, tag, index))
    .map(({ index }) => text.slice(0, index).split('\n').length);
}

describe('every slider has a name', () => {
  it('reads components at all, sliders among them', () => {
    expect(SOURCES.length).toBeGreaterThan(300);
    expect(SOURCES.flatMap(({ text }) => rangeInputs(text)).length).toBeGreaterThan(6);
  });

  it('no range input is left unnamed', () => {
    const offenders = SOURCES.flatMap(({ file, text }) =>
      unnamedIn(text).map((line) => `${file}:${line}`)
    );
    expect(offenders).toEqual([]);
  });

  it('the rule sees what it forbids, and what it accepts', () => {
    expect(unnamedIn('<div><span>Blur</span>\n<input type="range" min="0" /></div>')).toEqual([2]);
    expect(unnamedIn('<label>done</label><input\n  type="range"\n/>')).toEqual([1]);

    expect(unnamedIn('<label><span>Blur</span><input type="range" /></label>')).toEqual([]);
    expect(unnamedIn('<input type="range" aria-label={m.blur()} />')).toEqual([]);
    expect(
      unnamedIn('<input type="range" oninput={(e) => seek(e)} aria-label={m.position()} />')
    ).toEqual([]);
    expect(unnamedIn('<label for="blur">Blur</label><input id="blur" type="range" />')).toEqual([]);
    expect(unnamedIn('<input type="text" />')).toEqual([]);
  });
});
