// @vitest-environment happy-dom
import { Marked } from 'marked';
import { m } from '$lib/paraglide/messages';
import { computeComposerFormat } from './composerMarkdownFormat';
import { tolerateEmphasisWhitespace } from './emphasisTolerance';
import {
  classifyComposerLines,
  parseHeadingLine,
  parseInlineMarkdownPreview,
} from './inlinePreview';
import { preprocessPostMarkdown } from '$lib/utils/posts/postMarkdown';

/**
 * ONE corpus through BOTH paths: the published post (`preprocessPostMarkdown` + marked, the options
 * `PostMarkdown` hands svelte-markdown) and the composer's live preview (`inlinePreview.ts`). They
 * are two parsers because a contenteditable cannot host the renderer, so THIS test is what keeps
 * them one grammar. Reduced to "which text carries which style" so markup differences do not count.
 */

type Leaf = string;

const label = (styles: readonly string[]) => [...new Set(styles)].sort().join('+') || 'plain';

function renderedLeaves(md: string): Leaf[] {
  const html = new Marked({ gfm: true, breaks: true }).parse(preprocessPostMarkdown(md), {
    async: false,
  }) as string;
  const root = document.createElement('div');
  root.innerHTML = html;
  const leaves: Leaf[] = [];
  const walk = (node: Node, styles: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').replace(/\s+/g, '');
      if (text) leaves.push(`${label(styles)}:${text}`);
      return;
    }
    const tag = (node as Element).tagName?.toLowerCase();
    const style = (
      { strong: 'bold', em: 'italic', del: 'strike', code: 'code' } as Record<string, string>
    )[tag ?? ''];
    node.childNodes.forEach((child) => walk(child, style ? [...styles, style] : styles));
  };
  walk(root, []);
  return mergeAdjacent(leaves);
}

function previewLeaves(md: string): Leaf[] {
  const leaves: Leaf[] = [];
  const push = (styles: readonly string[], text: string) => {
    const t = text.replace(/\s+/g, '');
    if (t) leaves.push(`${label(styles)}:${t}`);
  };
  for (const { kind, line } of classifyComposerLines(md)) {
    if (kind !== 'normal') continue;
    const content = parseHeadingLine(line)?.content ?? line;
    for (const seg of parseInlineMarkdownPreview(content)) {
      if (seg.kind === 'text') push([], seg.value);
      else if (seg.kind === 'escape') push([], seg.char);
      else if (seg.kind === 'formatted') push(seg.styles, seg.content);
      else if (seg.kind === 'code') push(['code'], seg.content);
    }
  }
  return mergeAdjacent(leaves);
}

/** `plain:a` + `plain:b` read as one run, whatever the parser split between them. Whitespace is
 * dropped from every leaf: the question is WHICH TEXT carries WHICH STYLE, not how it is spaced. */
function mergeAdjacent(leaves: Leaf[]): Leaf[] {
  const out: Leaf[] = [];
  for (const leaf of leaves) {
    const at = leaf.indexOf(':');
    const style = leaf.slice(0, at);
    const text = leaf.slice(at + 1);
    const prev = out[out.length - 1];
    if (prev && prev.startsWith(`${style}:`)) out[out.length - 1] = `${prev}${text}`;
    else out.push(leaf);
  }
  return out;
}

/** A hand-written expectation, put through the same whitespace and merge rules as the parsers. */
const expectedLeaves = (leaves: Leaf[]): Leaf[] =>
  mergeAdjacent(leaves.map((l) => l.replace(/\s+/g, '')));

const CORPUS = [
  '**bold**',
  '*italic*',
  '***both***',
  '~~gone~~',
  '`code`',
  '__bold too__',
  '_italic too_',
  '**TOP 5 MINIMOYS **',
  '** leading**',
  '~~ gone ~~',
  'say **TOP 5 ** now',
  '# **x**',
  '## a **b** c',
  '### *i* title',
  '# **x **',
  '**bold *and italic* inside**',
  '*italic **and bold** inside*',
  'a ***b*** c',
  '2 * 3 * 4',
  'snake_case_name',
  '*x *',
  '\\*not italic\\*',
  '`**not bold**`',
  'plain text only',
  'foo**bar**baz',
];

describe('the composer preview and the published post read one grammar', () => {
  it.each(CORPUS)('%s', (md) => {
    expect(previewLeaves(md)).toEqual(renderedLeaves(md));
  });
});

describe('the renderer tolerates whitespace inside a double marker', () => {
  it('renders the production post bold', () => {
    expect(renderedLeaves('**TOP 5 MINIMOYS **')).toEqual(expectedLeaves(['bold:TOP 5 MINIMOYS']));
  });

  it('moves the whitespace out of the markers, nothing else', () => {
    expect(tolerateEmphasisWhitespace('**TOP 5 **')).toBe('**TOP 5** ');
    expect(tolerateEmphasisWhitespace('a ** b**c')).toBe('a  **b**c');
    expect(tolerateEmphasisWhitespace('~~ x ~~')).toBe(' ~~x~~ ');
  });

  it('leaves code, fences and single markers untouched', () => {
    expect(tolerateEmphasisWhitespace('`** x **`')).toBe('`** x **`');
    expect(tolerateEmphasisWhitespace('```\n** x **\n```')).toBe('```\n** x **\n```');
    expect(tolerateEmphasisWhitespace('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(tolerateEmphasisWhitespace('*x *')).toBe('*x *');
  });
});

/** Every row of the table in `docs/wiki/frontend/markdown-coherence.md`. */
describe('every toolbar action produces what its button promises', () => {
  const bold = m.md_placeholder_bold();
  const italic = m.md_placeholder_italic();

  const cases: Array<{
    name: string;
    type: string;
    text: string;
    sel: [number, number];
    expected: string;
    leaves: Leaf[];
  }> = [
    {
      name: 'bold',
      type: 'bold',
      text: 'a word b',
      sel: [2, 6],
      expected: 'a **word** b',
      leaves: ['plain:a', 'bold:word', 'plain:b'],
    },
    {
      name: 'bold, trailing space selected',
      type: 'bold',
      text: 'TOP 5 MINIMOYS x',
      sel: [0, 15],
      expected: '**TOP 5 MINIMOYS** x',
      leaves: ['bold:TOP 5 MINIMOYS', 'plain:x'],
    },
    {
      name: 'bold, both spaces selected',
      type: 'bold',
      text: 'a  word  b',
      sel: [1, 9],
      expected: 'a  **word**  b',
      leaves: ['plain:a', 'bold:word', 'plain:b'],
    },
    {
      name: 'italic, trailing space',
      type: 'italic',
      text: 'one two ',
      sel: [0, 8],
      expected: '*one two* ',
      leaves: ['italic:one two'],
    },
    {
      name: 'strike, trailing space',
      type: 'strikethrough',
      text: 'x y ',
      sel: [0, 4],
      expected: '~~x y~~ ',
      leaves: ['strike:x y'],
    },
    {
      name: 'code, trailing space',
      type: 'code',
      text: 'x y ',
      sel: [0, 4],
      expected: '`x y` ',
      leaves: ['code:x y'],
    },
    {
      name: 'bold, empty selection',
      type: 'bold',
      text: '',
      sel: [0, 0],
      expected: `**${bold}**`,
      leaves: [`bold:${bold}`],
    },
    {
      name: 'bold, whitespace-only selection',
      type: 'bold',
      text: 'a b',
      sel: [1, 2],
      expected: `a **${bold}**b`,
      leaves: ['plain:a', `bold:${bold}`, 'plain:b'],
    },
    {
      name: 'bold toggles off (markers selected)',
      type: 'bold',
      text: '**x**',
      sel: [0, 5],
      expected: 'x',
      leaves: ['plain:x'],
    },
    {
      name: 'bold toggles off (words selected)',
      type: 'bold',
      text: '**x**',
      sel: [2, 3],
      expected: 'x',
      leaves: ['plain:x'],
    },
    {
      name: 'italic on bold adds bold-italic',
      type: 'italic',
      text: '**x**',
      sel: [0, 5],
      expected: '***x***',
      leaves: ['bold+italic:x'],
    },
    {
      name: 'italic toggles off bold-italic, keeps bold',
      type: 'italic',
      text: '***x***',
      sel: [0, 7],
      expected: '**x**',
      leaves: ['bold:x'],
    },
    {
      name: 'bold toggles off bold-italic, keeps italic',
      type: 'bold',
      text: '***x***',
      sel: [0, 7],
      expected: '*x*',
      leaves: ['italic:x'],
    },
    {
      name: 'bold on italic adds bold-italic',
      type: 'bold',
      text: '*x*',
      sel: [0, 3],
      expected: '***x***',
      leaves: ['bold+italic:x'],
    },
    {
      name: 'bold, multi-line',
      type: 'bold',
      text: 'one\ntwo',
      sel: [0, 7],
      expected: '**one**\n**two**',
      leaves: ['bold:one two'],
    },
    {
      name: 'bold inside a heading',
      type: 'bold',
      text: '## Title here',
      sel: [3, 8],
      expected: '## **Title** here',
      leaves: ['bold:Title', 'plain:here'],
    },
    {
      name: 'bold on a whole heading line selected',
      type: 'bold',
      text: '## Title',
      sel: [0, 8],
      expected: '## **Title**',
      leaves: ['bold:Title'],
    },
    {
      name: 'bold on a list item line selected',
      type: 'bold',
      text: '- item',
      sel: [0, 6],
      expected: '- **item**',
      leaves: ['bold:item'],
    },
    {
      name: 'bold across list items',
      type: 'bold',
      text: '- a\n- b',
      sel: [0, 7],
      expected: '- **a**\n- **b**',
      leaves: ['bold:a', 'bold:b'],
    },
    {
      name: 'heading on a plain line',
      type: 'heading',
      text: 'Title',
      sel: [2, 2],
      expected: '## Title',
      leaves: ['plain:Title'],
    },
    {
      name: 'heading toggles off',
      type: 'heading',
      text: '## Title',
      sel: [4, 4],
      expected: 'Title',
      leaves: ['plain:Title'],
    },
    {
      name: 'heading toggles off an h1',
      type: 'heading',
      text: '# Title',
      sel: [0, 7],
      expected: 'Title',
      leaves: ['plain:Title'],
    },
    {
      name: 'heading keeps bold inside',
      type: 'heading',
      text: '**x**',
      sel: [0, 5],
      expected: '## **x**',
      leaves: ['bold:x'],
    },
    {
      name: 'heading replaces a list marker',
      type: 'heading',
      text: '- item',
      sel: [0, 6],
      expected: '## item',
      leaves: ['plain:item'],
    },
    {
      name: 'quote, multi-line',
      type: 'quote',
      text: 'a\nb',
      sel: [0, 3],
      expected: '> a\n> b',
      leaves: ['plain:a b'],
    },
    {
      name: 'quote toggles off',
      type: 'quote',
      text: '> a\n> b',
      sel: [0, 7],
      expected: 'a\nb',
      leaves: ['plain:a b'],
    },
    {
      name: 'list, multi-line',
      type: 'list',
      text: 'a\nb',
      sel: [0, 3],
      expected: '- a\n- b',
      leaves: ['plain:a', 'plain:b'],
    },
    {
      name: 'list skips a blank line',
      type: 'list',
      text: 'a\n\nb',
      sel: [0, 4],
      expected: '- a\n\n- b',
      leaves: ['plain:a', 'plain:b'],
    },
    {
      name: 'list replaces a quote',
      type: 'list',
      text: '> a',
      sel: [0, 3],
      expected: '- a',
      leaves: ['plain:a'],
    },
    {
      name: 'list toggles off',
      type: 'list',
      text: '- a',
      sel: [1, 1],
      expected: 'a',
      leaves: ['plain:a'],
    },
    {
      name: 'link, trailing space selected',
      type: 'link',
      text: 'see docs ',
      sel: [4, 9],
      expected: 'see [docs](url) ',
      leaves: ['plain:see', 'plain:docs'],
    },
    {
      name: 'link toggles off',
      type: 'link',
      text: '[docs](url)',
      sel: [0, 11],
      expected: 'docs',
      leaves: ['plain:docs'],
    },
  ];

  it.each(cases)('$name', ({ type, text, sel, expected, leaves }) => {
    const r = computeComposerFormat(type, text, sel[0], sel[1]);
    if (!r) throw new Error(`no result for ${type}`);
    expect(r.text).toBe(expected);
    // The selection always lands inside the new text, on the content the action touched.
    expect(r.selStart).toBeGreaterThanOrEqual(0);
    expect(r.selEnd).toBeLessThanOrEqual(r.text.length);
    expect(r.selStart).toBeLessThanOrEqual(r.selEnd);
    expect(renderedLeaves(r.text)).toEqual(expectedLeaves(leaves));
  });

  it('the italic placeholder is rendered italic', () => {
    const r = computeComposerFormat('italic', '', 0, 0);
    expect(renderedLeaves(r?.text ?? '')).toEqual(expectedLeaves([`italic:${italic}`]));
  });
});
