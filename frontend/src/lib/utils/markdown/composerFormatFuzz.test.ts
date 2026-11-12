import { Marked } from 'marked';
import { computeComposerFormat } from './composerMarkdownFormat';
import { tolerateEmphasisWhitespace } from './emphasisTolerance';

/**
 * THE TOOLBAR, FUZZED. Random lines of words under bold, italic and strike spans (nested or side by
 * side), every action applied to every selection of two families: whole words, and any range with
 * its edges snapped off marker runs. Two things must hold for every one of them, judged on what
 * marked alone draws:
 *  1. no `*`, `_` or `~` is left showing as text;
 *  2. no letter loses a style it had, except the style being toggled inside the selection.
 * Seeded and deterministic: a failure names its input.
 */

const marked = new Marked({ gfm: true, breaks: true });

type Kind = 'bold' | 'italic' | 'strikethrough';
const MARKER: Record<Kind, string> = { bold: '**', italic: '*', strikethrough: '~~' };
const TAG: Record<string, string> = { strong: 'bold', em: 'italic', del: 'strikethrough' };
const KINDS: Kind[] = ['bold', 'italic', 'strikethrough'];

let seed = 20261106;
const rand = (n: number) =>
  Math.floor(((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * n);

/** Words of letters, some under spans, spans nested one level or side by side. */
function randomLine(): string {
  const words = Array.from({ length: 4 + rand(7) }, () =>
    'abcdefghijklmn'.slice(rand(8), 9 + rand(5))
  );
  let i = 0;
  /** The words up to `limit`, space-separated, some under spans of a kind not already open. */
  const run = (depth: number, limit: number, banned: Kind[]): string => {
    const parts: string[] = [];
    while (i < limit) {
      const kinds = KINDS.filter((k) => !banned.includes(k));
      if (depth < 2 && kinds.length && rand(3) === 0) {
        const kind = kinds[rand(kinds.length)];
        const end = Math.min(limit, i + 1 + rand(4));
        parts.push(MARKER[kind] + run(depth + 1, end, [...banned, kind]) + MARKER[kind]);
      } else {
        parts.push(words[i++]);
      }
    }
    return parts.join(' ');
  };
  return run(0, words.length, []);
}

/**
 * The wild family: three levels deep, a style inside the same style, `***`, underscore spellings,
 * spans glued to the next word. Only what marked itself cannot read is filtered, by the caller.
 */
function wildLine(): string {
  const words = Array.from({ length: 4 + rand(8) }, () =>
    'abcdefghijklmn'.slice(rand(8), 9 + rand(5))
  );
  const markers = ['**', '*', '~~', '***', '_', '__'];
  let i = 0;
  const run = (depth: number, limit: number): string => {
    let out = '';
    while (i < limit) {
      const glue = out === '' ? '' : rand(5) === 0 ? '' : ' ';
      if (depth < 3 && rand(3) === 0) {
        const m = markers[rand(markers.length)];
        const end = Math.min(limit, i + 1 + rand(4));
        out += glue + m + run(depth + 1, end) + m;
      } else {
        out += glue + words[i++];
      }
    }
    return out;
  };
  return run(0, words.length);
}

/** Every letter of the rendering with the styles over it, and the text left showing as markers. */
function read(md: string): { letters: Array<Set<string>>; literal: number } {
  // As the published post draws it: through the tolerance, the same judge the toolbar uses.
  const html = marked.parse(tolerateEmphasisWhitespace(md), { async: false }) as string;
  const letters: Array<Set<string>> = [];
  const open: string[] = [];
  let literal = 0;
  for (const m of html.matchAll(/<(\/?)([a-z0-9]+)[^>]*>|([^<]+)/g)) {
    if (m[3] !== undefined) {
      literal += (m[3].match(/[*_~]/g) ?? []).length;
      for (const ch of m[3]) if (/[a-z]/.test(ch)) letters.push(new Set(open));
    } else if (TAG[m[2]]) {
      if (m[1]) open.pop();
      else open.push(TAG[m[2]]);
    }
  }
  return { letters, literal };
}

/** A selection edge inside a run of marker characters moves out of it. */
function snap(text: string, at: number, isEnd: boolean): number {
  const marker = (c: string | undefined) => c === '*' || c === '~';
  if (!marker(text[at - 1]) || !marker(text[at])) return at;
  let a = at;
  let b = at;
  while (marker(text[a - 1])) a--;
  while (marker(text[b])) b++;
  return isEnd ? a : b;
}

interface Failure {
  text: string;
  sel: [number, number];
  kind: Kind;
  out: string;
  why: string;
}

function check(text: string, s: number, e: number, kind: Kind): Failure | 'refused' | null {
  const letterAt = (p: number) => (text.slice(0, p).match(/[a-z]/g) ?? []).length;
  const l0 = letterAt(s);
  const l1 = letterAt(e);
  if (l1 <= l0) return null;
  const r = computeComposerFormat(kind, text, s, e);
  if (!r) return null;
  // A refusal writes nothing: the text comes back as it was.
  if (r.text === text) return 'refused';
  const before = read(text);
  const after = read(r.text);
  const fail = (why: string): Failure => ({ text, sel: [s, e], kind, out: r.text, why });
  if (after.literal > before.literal) return fail('literal marker');
  if (after.letters.length !== before.letters.length) return fail('letters changed');
  for (let i = 0; i < before.letters.length; i++) {
    for (const style of before.letters[i]) {
      if (style === kind && i >= l0 && i < l1) continue;
      if (!after.letters[i].has(style)) return fail(`letter ${i} lost ${style}`);
    }
  }
  return null;
}

/** All the selections of a line: whole words, or ranges with snapped edges. */
function selections(text: string, wholeWords: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  if (wholeWords) {
    const starts: number[] = [];
    const ends: number[] = [];
    for (const m of text.matchAll(/[a-z]+/g)) {
      starts.push(m.index);
      ends.push(m.index + m[0].length);
    }
    for (let i = 0; i < starts.length; i++) {
      for (let j = i; j < Math.min(starts.length, i + 4); j++) out.push([starts[i], ends[j]]);
    }
    // Words as the user selects them, with the marker run of a span at their edge.
    for (let i = 0; i < starts.length; i++) {
      const s = starts[i];
      let a = s;
      while (a > 0 && /[*~]/.test(text[a - 1])) a--;
      out.push([a, ends[Math.min(starts.length - 1, i + 1)]]);
    }
    return out;
  }
  for (let n = 0; n < 40; n++) {
    const a = rand(text.length);
    const b = a + 1 + rand(text.length - a);
    const s = snap(text, a, false);
    const e = snap(text, b, true);
    if (e > s) out.push([s, e]);
  }
  return out;
}

describe('the toolbar over random styled lines', () => {
  it.each([
    ['realistic, whole words', true, false, 600, 0.001],
    ['realistic, any range with edges snapped off markers', false, false, 600, 0.01],
    [
      'wild (***, same style inside itself, underscores, glued), whole words',
      true,
      true,
      600,
      0.35,
    ],
    ['wild, any range with edges snapped off markers', false, true, 600, 0.3],
  ] as const)(
    '%s: no literal marker, no style lost, refusals within their bound',
    (_n, whole, wild, lines, maxRefused) => {
      seed = (whole ? 20261106 : 20261107) + (wild ? 100 : 0);
      const warn = vi.spyOn(console, 'log').mockImplementation(() => {});
      let actions = 0;
      let refused = 0;
      const failures: Failure[] = [];
      for (let n = 0; n < lines; n++) {
        const text = wild ? wildLine() : randomLine();
        // Only what marked itself cannot read cleanly before the action is skipped.
        if ((!wild && text.includes('***')) || read(text).literal > 0) continue;
        for (const [s, e] of selections(text, whole)) {
          for (const kind of KINDS) {
            actions++;
            const f = check(text, s, e, kind);
            if (f === 'refused') refused++;
            else if (f) failures.push(f);
          }
        }
      }
      const refusals = warn.mock.calls.filter((c) => String(c[0]).includes('REFUSED')).length;
      warn.mockRestore();
      expect(actions).toBeGreaterThan(5000);
      expect(failures.slice(0, 5)).toEqual([]);
      // Every refusal is accused on the console, and (nearly) none is taken.
      expect(refusals).toBe(refused);
      expect(refused / actions).toBeLessThanOrEqual(maxRefused);
    },
    60_000
  );

  it.each([
    ['~~cd~~ ijk ab ~~lm~~ ~~h lm ab~~ h', 'ijk ab ~~lm~~ ~~h lm ab', 'bold'],
    ['lm **h lm** **cd cd** h', 'lm **h', 'italic'],
    ['**cd h efg** efg cd', 'h efg** efg', 'italic'],
    ['**cd cd lm** h efg **h ijk**', 'cd lm** h efg **h ijk', 'strikethrough'],
    ['lm **h lm**', 'lm **h', 'italic'],
    ['**a b** c', '**a b', 'italic'],
  ] as const)('review example %j, %j, %s', (text, picked, kind) => {
    const s = text.indexOf(picked);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(check(text, s, s + picked.length, kind)).toBeNull();
  });
});

/**
 * THE GRAMMAR THE BOUNDS ABOVE WERE MEASURED ON. A strong span opened inside a word and holding an
 * em is CommonMark's `x<strong>b <em>c</em> d</strong>` (markdown-it agrees). marked 18.1.2 to 18.2.0
 * (#4145, "rules 9-10 on the whole delimiter run") draws `x*<em>b <em>c</em> d*</em>` instead: stray
 * asterisks in a sent message, and the toolbar's refusals on the realistic family past their 1 %.
 * `marked` is held below 18.1.2 in `.github/dependabot.yml` until this passes on a newer release.
 */
describe('marked reads an intraword strong around an em as CommonMark does', () => {
  it.each([
    ['x**b *c* d**', 'x<strong>b <em>c</em> d</strong>'],
    ['ab**c *d e* f**', 'ab<strong>c <em>d e</em> f</strong>'],
  ])('%s', (source, html) => {
    expect(marked.parseInline(source)).toBe(html);
  });
});
