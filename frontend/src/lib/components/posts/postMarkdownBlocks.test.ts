/**
 * EVERY SURFACE THAT RENDERS MARKDOWN STATES ITS BLOCK RULES, AND STATES THEM IN ONE PLACE.
 *
 * A reader reported on 0.18.17 that a post read nothing like what was written: "the dashes do not
 * appear and the line breaks do not exist". The markdown was never at fault - `preprocessPostMarkdown`
 * plus marked produce exactly the `<p>`/`<ul><li>`/`<hr>` the author meant. Tailwind preflight then
 * strips `list-style` from every list and zeroes every margin, and the only gap anyone had ever
 * restored was `[&_p+p]:mt-3`, which matches a paragraph after a PARAGRAPH and nothing else.
 *
 * `ProfileBioMarkdown` had escaped it, because it happened to spell `[&_ul]:list-disc [&_ul]:pl-5`
 * in its own class string. THAT is the shape this file exists to prevent: a rule written into one
 * attribute is a rule the other surfaces cannot inherit, and nothing tells the author of the fourth
 * one that it was ever needed. The rules now live once, on `.post-markdown` in `app.css`, and what
 * is asserted here is the part a stylesheet cannot assert about itself - that every renderer is
 * actually wearing the class.
 *
 * Read as SOURCE, with comments stripped, because a check that reads its own prose is a check that
 * lies (`GifPickerModal.overlay.test.ts`, 2026-09-13).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '$lib/styles/markupSources';

const SRC = join(process.cwd(), 'src');

/** Every `.svelte` under `src`, so a renderer added anywhere is seen without a list to maintain. */
function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return svelteFiles(full);
    return name.endsWith('.svelte') ? [full] : [];
  });
}

const RENDERERS = svelteFiles(SRC)
  .map((path) => ({ path, body: withoutAnyComments(readFileSync(path, 'utf8')) }))
  .filter(({ body }) => body.includes('<SvelteMarkdown'));

describe('the markdown renderers', () => {
  it('are found at all - an empty sweep would pass every assertion below', () => {
    // The three known on 2026-09-21. More is fine and is the point; zero means the sweep broke.
    expect(RENDERERS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(RENDERERS.map((r) => r.path))('%s wears .post-markdown', (path) => {
    const { body } = RENDERERS.find((r) => r.path === path)!;
    expect(body).toContain('post-markdown');
  });

  it.each(RENDERERS.map((r) => r.path))('%s re-spells no block rule of its own', (path) => {
    const { body } = RENDERERS.find((r) => r.path === path)!;
    // The exact arbitrary variants that made the profile bio the only correct surface. A component
    // legitimately owns its headings, its font size and `[&_p]:inline`; it does not own whether a
    // list has bullets, because that answer cannot differ between two surfaces without one of them
    // being a defect.
    expect(body).not.toMatch(/\[&_(ul|ol)\]:(list-disc|list-decimal|pl-\d)/);
    expect(body).not.toMatch(/\[&_hr\]:/);
    expect(body).not.toMatch(/\[&_blockquote\]:/);
  });
});

describe('app.css states them once', () => {
  const css = readFileSync(join(SRC, 'app.css'), 'utf8');

  it.each([
    ['a list has markers', /\.post-markdown ul \{[^}]*list-style: disc/],
    ['an ordered list has numbers', /\.post-markdown ol \{[^}]*list-style: decimal/],
    ['a list is indented and spaced', /\.post-markdown :is\(ul, ol\) \{[^}]*padding-inline-start/],
    ['a rule is not welded to its neighbours', /\.post-markdown hr \{[^}]*margin-block/],
  ])('%s', (_what, pattern) => {
    expect(css).toMatch(pattern);
  });
});
