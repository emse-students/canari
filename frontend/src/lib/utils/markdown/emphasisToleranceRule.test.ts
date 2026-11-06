// @vitest-environment happy-dom
import { Marked } from 'marked';
import { analyseRendered, tolerateEmphasisWhitespace, type EmphasisRun } from './emphasisTolerance';
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
  let pos = 0;
  const walk = (node: Node, depth: number) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        pos += (child.textContent ?? '').replace(/[\s*_~]/gu, '').length;
        continue;
      }
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      const emphasis = tag === 'strong' || tag === 'em' || tag === 'del';
      const start = pos;
      // Code is drawn as it is written, but its characters still count toward an offset.
      walk(el, emphasis ? depth + 1 : depth);
      if (emphasis) {
        runs.push({
          tag: tag as EmphasisRun['tag'],
          text: norm(el.textContent ?? ''),
          depth,
          start,
          length: pos - start,
        });
      }
    }
  };
  walk(root, 0);
  return runs;
}

const sortRuns = (runs: EmphasisRun[]) =>
  runs.map((r) => `${r.tag}|${r.depth}|${r.start}|${r.length}|${r.text}`).sort();

/** Every emphasis of the raw render is still drawn: same tag, same place, same depth or deeper. */
function lossOf(md: string): string | null {
  // Judged by the independent DOM reader and a local comparison, never by the production one.
  const before = domRuns(render(md));
  const after = domRuns(render(tolerateEmphasisWhitespace(md)));
  const free = after.map((r) => ({ ...r, used: false }));
  for (const run of before) {
    const hit = free.find(
      (c) =>
        !c.used &&
        c.tag === run.tag &&
        c.start === run.start &&
        c.length === run.length &&
        c.depth >= run.depth
    );
    if (!hit) return md;
    hit.used = true;
  }
  return null;
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
    // review 3: same text twice, so a rewrite could move a bold from one place to the other
    '** a**a**a**',
    '~~ a~~a~~a~~',
    '****a ***a**',
    '**a **a**a*',
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
  }, 60_000);

  /** Every string of up to `max` tokens over `alphabet`: small enough to be ALL of them. */
  function exhaustive(alphabet: string[], max: number): string[] {
    let layer = [''];
    const all: string[] = [];
    for (let n = 1; n <= max; n++) {
      layer = layer.flatMap((p) => alphabet.map((t) => p + t));
      all.push(...layer);
    }
    return all;
  }

  it.each([[['**', ' ', 'a', '*']], [['~~', ' ', 'a', '**']]])(
    'loses nothing on EVERY string of up to 8 tokens over %j',
    (alphabet) => {
      const documents = exhaustive(alphabet, 8);
      const broken = documents.filter((md) => lossOf(md) !== null);
      expect(broken.slice(0, 5)).toEqual([]);
      expect(
        documents.filter((md) => tolerateEmphasisWhitespace(md) !== md).length
      ).toBeGreaterThan(100);
    },
    60_000
  );

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

  it('spends a fixed budget per DOCUMENT: past it, the rest is left as written', () => {
    // Six paragraphs of the worst shape (24+ loose spans, 7990 characters each): without a
    // document budget each is rendered 25 times.
    const paragraph = (n: number) => {
      const unit = `** w${n} ** `;
      return unit.repeat(Math.floor(7990 / unit.length));
    };
    const doc = Array.from({ length: 6 }, (_v, n) => paragraph(n)).join('\n\n');
    expect(doc.length).toBeGreaterThan(47000);
    const started = performance.now();
    const out = tolerateEmphasisWhitespace(doc);
    expect(performance.now() - started).toBeLessThan(2000);
    const before = doc.split('\n\n');
    const after = out.split('\n\n');
    expect(after).toHaveLength(6);
    // The head of the document is still tolerated, the tail is byte for byte what was written.
    expect(after[0]).not.toBe(before[0]);
    expect(after[5]).toBe(before[5]);
    expect(lossOf(doc)).toBeNull();
  });
});
