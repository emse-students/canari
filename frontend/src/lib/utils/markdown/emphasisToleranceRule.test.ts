// @vitest-environment happy-dom
import { Marked } from 'marked';
import {
  analyseRendered,
  preservesRuns,
  tolerateEmphasisWhitespace,
  type EmphasisRun,
} from './emphasisTolerance';
import { parseInlineMarkdownPreview } from './inlinePreview';

/**
 * THE RULE the tolerance is built around: no post that rendered an emphasis before may render
 * differently after. It holds by construction (`emphasisTolerance.ts` renders and compares), and
 * this file proves it from the outside: hand cases from two adversarial reviews, a deterministic
 * fuzz of 20000 documents, the scanner checked against a real DOM, and the preview's cost on the
 * shapes that once made it cubic.
 */

const render = (md: string): string =>
  new Marked({ gfm: true, breaks: true }).parse(md, { async: false }) as string;

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** The runs by an INDEPENDENT reader: a real DOM, not the production tag scanner. */
function domRuns(html: string): EmphasisRun[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  const runs: EmphasisRun[] = [];
  const walk = (node: Element, depth: number) => {
    for (const child of Array.from(node.children)) {
      const tag = child.tagName.toLowerCase();
      const emphasis = tag === 'strong' || tag === 'em' || tag === 'del';
      if (emphasis) {
        runs.push({
          tag: tag as EmphasisRun['tag'],
          text: norm(child.textContent ?? ''),
          depth,
        });
      }
      walk(child, emphasis ? depth + 1 : depth);
    }
  };
  walk(root, 0);
  return runs;
}

const sortRuns = (runs: EmphasisRun[]) => runs.map((r) => `${r.tag}|${r.depth}|${r.text}`).sort();

/** Every emphasis of the raw render is still drawn, at the same depth or deeper. */
function lossOf(md: string): string | null {
  const before = analyseRendered(render(md)).runs;
  const after = analyseRendered(render(tolerateEmphasisWhitespace(md))).runs;
  return preservesRuns(before, after) ? null : md;
}

describe('the tolerance never removes an emphasis that rendered before', () => {
  const hand = [
    '5 ** 2 = 25, **important**',
    'foo **bar ** baz** qux',
    'x ** y **bold**',
    '**a** b ** c ** d',
    'Prix ** 5 EUR ** et **promo**',
    '**a ** **b**',
    '[a **](u) and ** b',
    '- **a**\n- ** b **',
    // review 2: nested bold, which is what the old toolbar wrote around a phrase holding a bold word
    '**a **b** c**',
    '**Venez **nombreux** ce soir**',
    '~~a ~~b~~ c~~',
    // review 2: a bold continuing past a code span, a URL, a soft break, or a long distance
    'foo **bar ** `x` baz** qux',
    'foo **bar ** http://x.com/a baz** qux',
    'foo **bar **\nbaz** qux',
    `foo **bar ${'x '.repeat(1200)}** baz** qux`,
  ];

  it.each(hand.map((h) => [h.length > 60 ? `${h.slice(0, 40)}...` : h, h]))('%j', (_name, md) => {
    expect(lossOf(md)).toBeNull();
  });

  it('keeps the owner case and still fixes the loose ones', () => {
    expect(tolerateEmphasisWhitespace('**TOP 5 MINIMOYS **')).toBe('**TOP 5 MINIMOYS**');
    expect(tolerateEmphasisWhitespace('**a **b** c**')).toBe('**a **b** c**');
    expect(tolerateEmphasisWhitespace('foo **bar ** baz** qux')).toBe('foo **bar ** baz** qux');
  });

  /** Deterministic pseudo-random documents built from the pieces that make markdown hard. */
  function fuzz(count: number): string[] {
    const tokens = [
      '** ',
      ' **',
      '**',
      '***',
      '~~',
      '*',
      '_',
      '__',
      '`',
      '`x`',
      '- ',
      '> ',
      '1. ',
      '[a](u)',
      'http://x.com/',
      '\n',
      '\n',
      '\n\n',
      '  ',
      '    ',
      'a',
      'b c',
      'x',
      '1',
      ' ',
    ];
    let seed = 20261106;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    return Array.from({ length: count }, () =>
      Array.from(
        { length: 3 + Math.floor(next() * 16) },
        () => tokens[Math.floor(next() * tokens.length)]
      ).join('')
    );
  }

  it('holds over 20000 generated documents, emphasis of every kind included', () => {
    const documents = fuzz(20000);
    const broken = documents.filter((md) => lossOf(md) !== null);
    expect(broken.slice(0, 5)).toEqual([]);
    // The generator must actually reach the tolerance: a rule tested on inputs it never touches
    // proves nothing.
    const touched = documents.filter((md) => tolerateEmphasisWhitespace(md) !== md).length;
    expect(touched).toBeGreaterThan(500);
  });

  it('reads the same runs as a real DOM does', () => {
    for (const md of fuzz(1500)) {
      const html = render(md);
      expect(sortRuns(analyseRendered(html).runs)).toEqual(sortRuns(domRuns(html)));
    }
  });
});

/**
 * Cost. Step counting is not available, so the bounds are generous (the cubic version took 1.7 s at
 * 5000 characters and two minutes at 20000, against a few milliseconds now): a regression to
 * anything worse than mildly quadratic fails by orders of magnitude, a slow CI box does not.
 */
describe('the composer preview stays linear on stray markers', () => {
  const shapes: Array<[string, string]> = [
    ['`**a ` x 5000', '**a '.repeat(5000)],
    ['`*a ` x 6600', '*a '.repeat(6600)],
    ['`__a ` x 5000', '__a '.repeat(5000)],
    ['`~~a ` x 5000', '~~a '.repeat(5000)],
    ['`** a ` x 4000', '** a '.repeat(4000)],
    ['`**a ** ` x 2900', '**a ** '.repeat(2900)],
    ['one opener then 10000 words', '**' + ' a'.repeat(10000)],
    ['backticks', '`a '.repeat(6600)],
    ['`h ` x 10000 (URL probes)', 'h '.repeat(10000)],
    ['`**a **b ` nested x 3300', '**a **b '.repeat(2500)],
  ];

  it.each(shapes)('%s', (_name, text) => {
    const started = performance.now();
    parseInlineMarkdownPreview(text);
    expect(performance.now() - started).toBeLessThan(400);
  });

  it('keeps the renderer tolerance bounded on a long stray-marker paragraph', () => {
    const started = performance.now();
    tolerateEmphasisWhitespace('x ** y '.repeat(1100));
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
