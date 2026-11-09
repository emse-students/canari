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
 * them one grammar. Reduced to "which text carries which style", whitespace collapsed to single
 * spaces and kept (a moved space must land where it should), block boundaries read as a space.
 *
 * WHAT PARITY COVERS: inline emphasis (bold, italic, bold-italic, strike, code), their escapes, and
 * ATX headings, over ONE line at a time. WHAT IT DOES NOT: a span crossing a line break, and
 * anything marked draws that the preview does not style (links, lists, quotes). Those are the
 * KNOWN_GAPS below, each asserted to still differ so that fixing one forces the wiki to change.
 */

type Piece = { style: string; text: string };

const label = (styles: readonly string[]) => [...new Set(styles)].sort().join('+') || 'plain';
const BREAKS = new Set(['p', 'li', 'ul', 'ol', 'blockquote', 'br', 'pre', 'h1', 'h2', 'h3', 'h4']);

/** Merges neighbours of one style, then collapses and trims each, dropping the empty ones. */
function finish(pieces: Piece[]): string[] {
  const merged: Piece[] = [];
  for (const piece of pieces) {
    const prev = merged[merged.length - 1];
    if (prev && prev.style === piece.style) prev.text += piece.text;
    else merged.push({ ...piece });
  }
  return merged
    .map((p) => `${p.style}:${p.text.replace(/\s+/g, ' ').trim()}`)
    .filter((l) => !l.endsWith(':'));
}

function leavesOfHtml(html: string): string[] {
  const root = document.createElement('div');
  root.innerHTML = html;
  const pieces: Piece[] = [];
  const addBreak = () => {
    if (pieces.length) pieces[pieces.length - 1].text += ' ';
  };
  const walk = (node: Node, styles: string[]) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pieces.push({ style: label(styles), text: node.textContent ?? '' });
      return;
    }
    const tag = (node as Element).tagName?.toLowerCase() ?? '';
    const style = (
      { strong: 'bold', em: 'italic', del: 'strike', code: 'code' } as Record<string, string>
    )[tag];
    node.childNodes.forEach((child) => walk(child, style ? [...styles, style] : styles));
    if (BREAKS.has(tag)) addBreak();
  };
  walk(root, []);
  return finish(pieces);
}

const marked = () => new Marked({ gfm: true, breaks: true });
const html = (md: string): string => marked().parse(md, { async: false }) as string;

/** The post as it renders: the real pipeline, tolerance included. */
const postLeaves = (md: string) => leavesOfHtml(html(preprocessPostMarkdown(md)));
/** marked ALONE: what a toolbar output must survive without the tolerance's help. */
const rawLeaves = (md: string) => leavesOfHtml(html(md));

function previewLeaves(md: string): string[] {
  const pieces: Piece[] = [];
  const push = (styles: readonly string[], text: string) =>
    pieces.push({ style: label(styles), text });
  for (const { kind, line } of classifyComposerLines(md)) {
    if (kind !== 'normal') continue;
    const content = parseHeadingLine(line)?.content ?? line;
    for (const seg of parseInlineMarkdownPreview(content)) {
      if (seg.kind === 'text') push([], seg.value);
      else if (seg.kind === 'escape') push([], seg.char);
      else if (seg.kind === 'formatted') push(seg.styles, seg.content);
      else if (seg.kind === 'code') push(['code'], seg.content);
    }
    if (pieces.length) pieces[pieces.length - 1].text += ' ';
  }
  return finish(pieces);
}

/** A hand-written expectation, put through the same merge and whitespace rules as the parsers. */
const expectedLeaves = (leaves: string[]): string[] =>
  finish(
    leaves.map((l) => {
      const at = l.indexOf(':');
      return { style: l.slice(0, at), text: l.slice(at + 1) };
    })
  );

const CORPUS = [
  '**bold**',
  '*italic*',
  '***both***',
  '~~gone~~',
  '~strike~',
  '`code`',
  '`` a`b ** c ** ``',
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
  'foo__bar__baz',
  'a__b__',
  '*x *',
  '\\*not italic\\*',
  '`**not bold**`',
  'plain text only',
  'foo**bar**baz',
  '5 ** 2 = 25, **important**',
  'x ** y **bold**',
  'foo **bar ** baz** qux',
  '**TOP 5 ** and **other**',
  '**Lundi :** 18h ** Mardi :** 20h',
  'http://x.com/**a**',
  'see https://x.com/a__b__c ok',
  '**1** ** 2** **3**',
];

describe('the composer preview and the published post read one grammar', () => {
  it.each(CORPUS)('%s', (md) => {
    expect(previewLeaves(md)).toEqual(postLeaves(md));
  });
});

/** Documented divergences: each is asserted to STILL differ, so a fix must update the wiki. */
const KNOWN_GAPS = ['**a\nb**', '~~a ~~b~~', '***a** b*', '**a *b** c*', '**a **b** c**'];

describe('known gaps, stated in docs/wiki/frontend/markdown-coherence.md', () => {
  it.each(KNOWN_GAPS)('%j still differs', (md) => {
    expect(previewLeaves(md)).not.toEqual(postLeaves(md));
  });
});

describe('the renderer tolerates whitespace inside a double marker', () => {
  it('renders the production post bold', () => {
    expect(postLeaves('**TOP 5 MINIMOYS **')).toEqual(expectedLeaves(['bold:TOP 5 MINIMOYS']));
  });

  it('moves the whitespace out of the markers, nothing else', () => {
    expect(tolerateEmphasisWhitespace('**TOP 5 **')).toBe('**TOP 5**');
    expect(tolerateEmphasisWhitespace('say **TOP 5 ** now')).toBe('say **TOP 5** now');
    expect(tolerateEmphasisWhitespace('a** b** c')).toBe('a **b** c');
    expect(tolerateEmphasisWhitespace('~~ x ~~ y')).toBe('~~x~~ y');
  });

  it('never widens a list item or doubles a space', () => {
    expect(tolerateEmphasisWhitespace('- ** item **\n  - ** nested **')).toBe(
      '- **item**\n  **nested**'.replace('  **nested**', '  - **nested**')
    );
    expect(tolerateEmphasisWhitespace('1. ** x**')).toBe('1. **x**');
    expect(tolerateEmphasisWhitespace('a ** b ** c')).toBe('a **b** c');
    expect(tolerateEmphasisWhitespace('**TOP 5 ** and **other**')).toBe('**TOP 5** and **other**');
    const nested = html(preprocessPostMarkdown('- ** item **\n  - ** nested **'));
    expect(nested).toMatch(/<ul>[\s\S]*<ul>/);
  });

  it('leaves code, fences, URLs and single markers untouched', () => {
    const same = [
      '`** x **`',
      '`` a`b ** c ** ``',
      '```\n** x **\n```',
      '~~~\n** x **\n~~~',
      '- item\n  ```\n  ** x **\n  ```',
      'para\n\n    ** x **\n',
      'see http://x.com/** a **',
      '2 * 3 * 4',
      '*x *',
    ];
    for (const md of same) expect(tolerateEmphasisWhitespace(md)).toBe(md);
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
    /** The text the selection must cover afterwards: what the action touched. */
    selected: string;
    leaves: string[];
  }> = [
    {
      name: 'bold',
      type: 'bold',
      text: 'a word b',
      sel: [2, 6],
      expected: 'a **word** b',
      selected: 'word',
      leaves: ['plain:a', 'bold:word', 'plain:b'],
    },
    {
      name: 'bold, trailing space selected',
      type: 'bold',
      text: 'TOP 5 MINIMOYS x',
      sel: [0, 15],
      expected: '**TOP 5 MINIMOYS** x',
      selected: 'TOP 5 MINIMOYS',
      leaves: ['bold:TOP 5 MINIMOYS', 'plain:x'],
    },
    {
      name: 'bold, both spaces selected',
      type: 'bold',
      text: 'a  word  b',
      sel: [1, 9],
      expected: 'a  **word**  b',
      selected: 'word',
      leaves: ['plain:a', 'bold:word', 'plain:b'],
    },
    {
      name: 'italic, trailing space',
      type: 'italic',
      text: 'one two ',
      sel: [0, 8],
      expected: '*one two* ',
      selected: 'one two',
      leaves: ['italic:one two'],
    },
    {
      name: 'strike, trailing space',
      type: 'strikethrough',
      text: 'x y ',
      sel: [0, 4],
      expected: '~~x y~~ ',
      selected: 'x y',
      leaves: ['strike:x y'],
    },
    {
      name: 'code, trailing space',
      type: 'code',
      text: 'x y ',
      sel: [0, 4],
      expected: '`x y` ',
      selected: 'x y',
      leaves: ['code:x y'],
    },
    {
      name: 'bold, empty selection',
      type: 'bold',
      text: '',
      sel: [0, 0],
      expected: `**${bold}**`,
      selected: bold,
      leaves: [`bold:${bold}`],
    },
    {
      name: 'bold, whitespace-only selection',
      type: 'bold',
      text: 'a b',
      sel: [1, 2],
      expected: `a **${bold}**b`,
      selected: bold,
      leaves: ['plain:a', `bold:${bold}`, 'plain:b'],
    },
    {
      name: 'bold toggles off (markers selected)',
      type: 'bold',
      text: '**x**',
      sel: [0, 5],
      expected: 'x',
      selected: 'x',
      leaves: ['plain:x'],
    },
    {
      name: 'bold toggles off (words selected)',
      type: 'bold',
      text: '**x**',
      sel: [2, 3],
      expected: 'x',
      selected: 'x',
      leaves: ['plain:x'],
    },
    {
      name: 'italic on bold adds bold-italic',
      type: 'italic',
      text: '**x**',
      sel: [0, 5],
      expected: '**_x_**',
      selected: 'x',
      leaves: ['bold+italic:x'],
    },
    {
      name: 'italic toggles off bold-italic, keeps bold',
      type: 'italic',
      text: '***x***',
      sel: [0, 7],
      expected: '**x**',
      selected: 'x',
      leaves: ['bold:x'],
    },
    {
      name: 'bold toggles off bold-italic, keeps italic',
      type: 'bold',
      text: '***x***',
      sel: [0, 7],
      expected: '*x*',
      selected: 'x',
      leaves: ['italic:x'],
    },
    {
      name: 'bold on italic adds bold-italic',
      type: 'bold',
      text: '*x*',
      sel: [0, 3],
      expected: '**_x_**',
      selected: 'x',
      leaves: ['bold+italic:x'],
    },
    {
      name: 'bold, multi-line',
      type: 'bold',
      text: 'one\ntwo',
      sel: [0, 7],
      expected: '**one**\n**two**',
      selected: 'one**\n**two',
      leaves: ['bold:one two'],
    },
    {
      name: 'bold over two separate bold runs merges them',
      type: 'bold',
      text: '**Prix** : 5 **ce soir**',
      sel: [0, 24],
      expected: '**Prix : 5 ce soir**',
      selected: 'Prix : 5 ce soir',
      leaves: ['bold:Prix : 5 ce soir'],
    },
    {
      name: 'italic over two separate italic runs merges them',
      type: 'italic',
      text: '*a* and *b*',
      sel: [0, 11],
      expected: '*a and b*',
      selected: 'a and b',
      leaves: ['italic:a and b'],
    },
    {
      name: 'bold over a bold run and an italic run makes one span',
      type: 'bold',
      text: '**a** and *b*',
      sel: [0, 13],
      expected: '**a and _b_**',
      selected: 'a and _b_',
      leaves: ['bold:a and', 'bold+italic:b'],
    },
    {
      name: 'bold on a partial edge run',
      type: 'bold',
      text: '**a',
      sel: [0, 3],
      expected: '**a**',
      selected: 'a',
      leaves: ['bold:a'],
    },
    {
      name: 'bold keeps a lone * with spaces around it as text',
      type: 'bold',
      text: '2 * 3',
      sel: [0, 5],
      expected: '**2 * 3**',
      selected: '2 * 3',
      leaves: ['bold:2 * 3'],
    },
    {
      name: 'bold off on the last word of a bold phrase splits the span',
      type: 'bold',
      text: '**Prix ce soir**',
      sel: [10, 14],
      expected: '**Prix ce** soir',
      selected: 'soir',
      leaves: ['bold:Prix ce', 'plain:soir'],
    },
    {
      name: 'bold off on the first word of a bold phrase',
      type: 'bold',
      text: '**Prix ce soir**',
      sel: [2, 6],
      expected: 'Prix **ce soir**',
      selected: 'Prix',
      leaves: ['plain:Prix', 'bold:ce soir'],
    },
    {
      name: 'bold off on the middle word of a bold phrase splits it in two',
      type: 'bold',
      text: '**Prix ce soir**',
      sel: [7, 9],
      expected: '**Prix** ce **soir**',
      selected: 'ce',
      leaves: ['bold:Prix', 'plain:ce', 'bold:soir'],
    },
    {
      name: 'bold off on the last letter of a two-letter span',
      type: 'bold',
      text: '**ab**',
      sel: [3, 4],
      expected: '**a**b',
      selected: 'b',
      leaves: ['bold:a', 'plain:b'],
    },
    {
      name: 'strike off on a word inside a struck phrase',
      type: 'strikethrough',
      text: '~~Prix ce soir~~',
      sel: [10, 14],
      expected: '~~Prix ce~~ soir',
      selected: 'soir',
      leaves: ['strike:Prix ce', 'plain:soir'],
    },
    {
      name: 'bold off on a word inside a bold-italic span keeps the italic',
      type: 'bold',
      text: '***ab cd***',
      sel: [6, 8],
      expected: '_**ab** cd_',
      selected: 'cd',
      leaves: ['bold+italic:ab', 'italic:cd'],
    },
    {
      name: 'bold off over two adjacent bold spans and the space between',
      type: 'bold',
      text: '**a** **b**',
      sel: [0, 11],
      expected: 'a b',
      selected: 'a b',
      leaves: ['plain:a b'],
    },
    {
      name: 'bold over a selection crossing the end of a bold span',
      type: 'bold',
      text: '**Prix ce soir** demain',
      sel: [10, 23],
      expected: '**Prix ce soir demain**',
      selected: 'Prix ce soir demain',
      leaves: ['bold:Prix ce soir demain'],
    },
    {
      name: 'bold crossing the end of a short bold span',
      type: 'bold',
      text: '**a b** c',
      sel: [4, 9],
      expected: '**a b c**',
      selected: 'a b c',
      leaves: ['bold:a b c'],
    },
    {
      name: 'bold crossing the end, selection starting at the span content',
      type: 'bold',
      text: '**a b** c',
      sel: [2, 9],
      expected: '**a b c**',
      selected: 'a b c',
      leaves: ['bold:a b c'],
    },
    {
      name: 'bold crossing the start of a bold span',
      type: 'bold',
      text: 'a **b c**',
      sel: [0, 5],
      expected: '**a b c**',
      selected: 'a b c',
      leaves: ['bold:a b c'],
    },
    {
      name: 'bold crossing the start of a bold span, from a word before',
      type: 'bold',
      text: 'hier **Prix ce soir**',
      sel: [0, 10],
      expected: '**hier Prix ce soir**',
      selected: 'hier Prix ce soir',
      leaves: ['bold:hier Prix ce soir'],
    },
    {
      name: 'italic crossing the end of an italic span',
      type: 'italic',
      text: '*a b* c',
      sel: [3, 7],
      expected: '*a b c*',
      selected: 'a b c',
      leaves: ['italic:a b c'],
    },
    {
      name: 'strike crossing the end of a struck span',
      type: 'strikethrough',
      text: '~~a b~~ c',
      sel: [4, 9],
      expected: '~~a b c~~',
      selected: 'a b c',
      leaves: ['strike:a b c'],
    },
    {
      name: 'bold on a word touching a bold span merges with it',
      type: 'bold',
      text: '**a**b',
      sel: [5, 6],
      expected: '**ab**',
      selected: 'ab',
      leaves: ['bold:ab'],
    },
    {
      name: 'bold on a word touching a bold span on its right merges with it',
      type: 'bold',
      text: 'a**b**',
      sel: [0, 1],
      expected: '**ab**',
      selected: 'ab',
      leaves: ['bold:ab'],
    },
    {
      name: 'production shape: bold off on the whole of `**TOP 5 MINIMOYS **` (the post draws it bold)',
      type: 'bold',
      text: '**TOP 5 MINIMOYS **',
      sel: [0, 19],
      expected: 'TOP 5 MINIMOYS ',
      selected: 'TOP 5 MINIMOYS ',
      leaves: ['plain:TOP 5 MINIMOYS '],
    },
    {
      name: 'production shape: bold off on MINIMOYS of `**TOP 5 MINIMOYS **`',
      type: 'bold',
      text: '**TOP 5 MINIMOYS **',
      sel: [8, 16],
      expected: '**TOP 5** MINIMOYS ',
      selected: 'MINIMOYS',
      leaves: ['bold:TOP 5', 'plain:MINIMOYS '],
    },
    {
      name: 'bold inside a heading',
      type: 'bold',
      text: '## Title here',
      sel: [3, 8],
      expected: '## **Title** here',
      selected: 'Title',
      leaves: ['bold:Title', 'plain:here'],
    },
    {
      name: 'bold on a whole heading line selected',
      type: 'bold',
      text: '## Title',
      sel: [0, 8],
      expected: '## **Title**',
      selected: 'Title',
      leaves: ['bold:Title'],
    },
    {
      name: 'bold on a list item line selected',
      type: 'bold',
      text: '- item',
      sel: [0, 6],
      expected: '- **item**',
      selected: 'item',
      leaves: ['bold:item'],
    },
    {
      name: 'bold across list items',
      type: 'bold',
      text: '- a\n- b',
      sel: [0, 7],
      expected: '- **a**\n- **b**',
      selected: 'a**\n- **b',
      leaves: ['bold:a', 'plain: ', 'bold:b'],
    },
    {
      name: 'bold on a nested item',
      type: 'bold',
      text: '- item\n  - sub',
      sel: [7, 14],
      expected: '- item\n  - **sub**',
      selected: 'sub',
      leaves: ['plain:item', 'bold:sub'],
    },
    {
      name: 'bold on a quoted item',
      type: 'bold',
      text: '> - item',
      sel: [0, 8],
      expected: '> - **item**',
      selected: 'item',
      leaves: ['bold:item'],
    },
    {
      name: 'bold on an ordered-paren item',
      type: 'bold',
      text: '1) item',
      sel: [0, 7],
      expected: '1) **item**',
      selected: 'item',
      leaves: ['bold:item'],
    },
    {
      name: 'bold on a task item',
      type: 'bold',
      text: '- [ ] task',
      sel: [0, 10],
      expected: '- [ ] **task**',
      selected: 'task',
      leaves: ['bold:task'],
    },
    {
      name: 'heading on a plain line',
      type: 'heading',
      text: 'Title',
      sel: [2, 2],
      expected: '## Title',
      selected: '',
      leaves: ['plain:Title'],
    },
    {
      name: 'heading toggles off',
      type: 'heading',
      text: '## Title',
      sel: [4, 4],
      expected: 'Title',
      selected: '',
      leaves: ['plain:Title'],
    },
    {
      name: 'heading toggles off an h1',
      type: 'heading',
      text: '# Title',
      sel: [0, 7],
      expected: 'Title',
      selected: 'Title',
      leaves: ['plain:Title'],
    },
    {
      name: 'heading keeps bold inside',
      type: 'heading',
      text: '**x**',
      sel: [0, 5],
      expected: '## **x**',
      selected: '**x**',
      leaves: ['bold:x'],
    },
    {
      name: 'heading replaces a list marker',
      type: 'heading',
      text: '- item',
      sel: [0, 6],
      expected: '## item',
      selected: 'item',
      leaves: ['plain:item'],
    },
    {
      name: 'heading on a nested item drops the indent',
      type: 'heading',
      text: '  - sub',
      sel: [0, 7],
      expected: '## sub',
      selected: 'sub',
      leaves: ['plain:sub'],
    },
    {
      name: 'quote, multi-line',
      type: 'quote',
      text: 'a\nb',
      sel: [0, 3],
      expected: '> a\n> b',
      selected: 'a\n> b',
      leaves: ['plain:a b'],
    },
    {
      name: 'quote toggles off',
      type: 'quote',
      text: '> a\n> b',
      sel: [0, 7],
      expected: 'a\nb',
      selected: 'a\nb',
      leaves: ['plain:a b'],
    },
    {
      name: 'quote on a list item',
      type: 'quote',
      text: '- a',
      sel: [0, 3],
      expected: '> - a',
      selected: 'a',
      leaves: ['plain:a'],
    },
    {
      name: 'list, multi-line',
      type: 'list',
      text: 'a\nb',
      sel: [0, 3],
      expected: '- a\n- b',
      selected: 'a\n- b',
      leaves: ['plain:a b'],
    },
    {
      name: 'list skips a blank line',
      type: 'list',
      text: 'a\n\nb',
      sel: [0, 4],
      expected: '- a\n\n- b',
      selected: 'a\n\n- b',
      leaves: ['plain:a b'],
    },
    {
      name: 'list replaces a heading',
      type: 'list',
      text: '## a',
      sel: [0, 4],
      expected: '- a',
      selected: 'a',
      leaves: ['plain:a'],
    },
    {
      name: 'list on a quoted line keeps the quote',
      type: 'list',
      text: '> a',
      sel: [0, 3],
      expected: '> - a',
      selected: 'a',
      leaves: ['plain:a'],
    },
    {
      name: 'list toggles off',
      type: 'list',
      text: '- a',
      sel: [1, 1],
      expected: 'a',
      selected: '',
      leaves: ['plain:a'],
    },
    {
      name: 'list toggles off a nested item and keeps its indent',
      type: 'list',
      text: '- a\n  - b',
      sel: [4, 9],
      expected: '- a\n  b',
      selected: 'b',
      leaves: ['plain:a b'],
    },
    {
      name: 'link, trailing space selected',
      type: 'link',
      text: 'see docs ',
      sel: [4, 9],
      expected: 'see [docs](url) ',
      selected: 'url',
      leaves: ['plain:see docs'],
    },
    {
      name: 'link toggles off',
      type: 'link',
      text: '[docs](url)',
      sel: [0, 11],
      expected: 'docs',
      selected: 'docs',
      leaves: ['plain:docs'],
    },
  ];

  it.each(cases)('$name', ({ type, text, sel, expected, selected, leaves }) => {
    const r = computeComposerFormat(type, text, sel[0], sel[1]);
    if (!r) throw new Error(`no result for ${type}`);
    expect(r.text).toBe(expected);
    // The selection lands on the text the action touched, not merely inside the string.
    expect(r.text.slice(r.selStart, r.selEnd)).toBe(selected);
    // marked ALONE, no tolerance: a toolbar output may not lean on the renderer's leniency.
    expect(rawLeaves(r.text)).toEqual(expectedLeaves(leaves));
  });

  /** Presses `type` twice over the whole text (the second press selects what the first left). */
  const twice = (type: Parameters<typeof computeComposerFormat>[0], text: string) => {
    const one = computeComposerFormat(type, text, 0, text.length);
    if (!one) throw new Error('no first result');
    const two = computeComposerFormat(type, one.text, one.selStart, one.selEnd);
    if (!two) throw new Error('no second result');
    return [one.text, two.text];
  };

  // Press twice, over the whole text: [type, text, after one press, after two].
  // The ROUND TRIPS are the rows whose last column equals the second; the others are the
  // documented semantics of "wrap everything": a style nested inside the selection is absorbed
  // (Google Docs does the same), so the second press cannot give it back.
  it.each([
    ['italic', '**a** b **c**', '_**a** b **c**_', '**a** b **c**'],
    ['bold', 'a ** b ** c', '**a  b  c**', 'a  b  c'],
    ['bold', 'plain words', '**plain words**', 'plain words'],
    ['italic', 'plain words', '*plain words*', 'plain words'],
    ['strikethrough', 'plain words', '~~plain words~~', 'plain words'],
    ['bold', '**Prix ce soir**', 'Prix ce soir', '**Prix ce soir**'],
    // not round trips: the nested style is absorbed by the wrap
    ['bold', 'a **b** c', '**a b c**', 'a b c'],
    ['strikethrough', 'a ~~b~~ c', '~~a b c~~', 'a b c'],
    ['italic', '**a *b* c**', '**_a b c_**', '**a b c**'],
  ] as const)('%s pressed twice on %j gives %j then %j', (type, text, first, second) => {
    expect(twice(type, text)).toEqual([first, second]);
    // Markers never pile up.
    expect(first.includes('****')).toBe(false);
  });

  it('the italic placeholder is rendered italic', () => {
    const r = computeComposerFormat('italic', '', 0, 0);
    expect(rawLeaves(r?.text ?? '')).toEqual(expectedLeaves([`italic:${italic}`]));
  });
});
