/**
 * EVERY MENU OF THE APP HAS ONE OF TWO SHAPES, OR THIS FAILS (section navigation, CLOSED 2026-10-13).
 *
 * The user's rule (2026-10-08, *"Le but n'est pas d'avoir des menus caches"*): a set of three or
 * so short labels is a FIXED segmented control - `SegmentedControl`, every entry visible at
 * 320 px - and anything bigger is a hub of route sections under a breadcrumb. The chantier moved
 * every menu to one of those two shapes; what would undo it is a third pattern written by hand,
 * which is how the scrolling strips appeared in the first place. Three properties, asserted over
 * the whole tree rather than over the files the chantier touched:
 *
 * 1. NO HAND-MADE TAB SET: one variable set to two different string literals by two inline
 *    `onclick` handlers is a tab row someone drew. The shop's products/partnerships pair was the
 *    last one (no tablist semantics, lost on reload).
 * 2. `role="tablist"` belongs to `SegmentedControl`. The emoji picker's category row is the one
 *    exception: a tool row of pictograms inside a picker, not a menu of sections.
 * 3. NO RAW HISTORY WRITE: a section is a route and an overlay is an entry of
 *    `historyOverlayStack`; anything else goes through SvelteKit's `replaceState`/`goto`. A raw
 *    `history.replaceState(null, ...)` - the shop's checkout return did it - erases the router's
 *    entry state, which is what the overlay stack and the router's Back both read.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allMarkup, shippedSourceFiles, withoutAnyComments } from './markupSources';

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const posix = (file: string) => file.split(sep).join('/');

/** Files allowed to declare a tablist, each with the reason it is not a menu. */
const TABLIST_OWNERS: Record<string, string> = {
  'lib/components/ui/SegmentedControl.svelte': 'the ONE fixed tab control',
  'lib/components/messages/EmojiGrid.svelte': 'emoji categories: a picker tool row, not sections',
};

/** The one module allowed to write the History API itself. */
const HISTORY_OWNER = 'lib/utils/historyOverlayStack.ts';

/** `{ variable: literals }` set by inline `onclick={() => (x = 'literal')}` handlers in `body`. */
function inlineTabAssignments(body: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const pattern = /onclick=\{\s*\(\)\s*=>\s*\(?\s*(\w+)\s*=\s*['"]([\w-]+)['"]\s*\)?\s*\}/g;
  for (const [, variable, literal] of body.matchAll(pattern)) {
    const set = found.get(variable) ?? new Set<string>();
    set.add(literal);
    found.set(variable, set);
  }
  return found;
}

describe('the gate reads what it claims', () => {
  it('sees a hand-made pair and ignores a single toggle', () => {
    const pair = `<button onclick={() => (tab = 'a')}>A</button><button onclick={() => (tab = 'b')}>B</button>`;
    expect([...(inlineTabAssignments(pair).get('tab') ?? [])]).toEqual(['a', 'b']);
    const single = `<button onclick={() => (mode = 'a')}>A</button>`;
    expect(inlineTabAssignments(single).get('mode')?.size).toBe(1);
  });
});

// THE TREE IS READ ONCE, HERE, AND NOT INSIDE A TEST. A test body is charged against vitest's 5 s
// timeout, and under the full suite, with every worker reading the disk at once, the walk of every
// shipped `.ts` and `.svelte` file took seconds on its own. Module scope is collection time, which
// no per-test timeout measures.
const markup = allMarkup(src).map(({ file, body }) => ({ file: posix(file), body }));
const code = shippedSourceFiles(join(src, 'lib'))
  .concat(shippedSourceFiles(join(src, 'routes')))
  .map((file) => ({
    file: posix(relative(src, file)),
    body: withoutAnyComments(readFileSync(file, 'utf8')),
  }));

describe('every menu is a segmented control or a hub', () => {
  it('no variable is switched between string literals by inline handlers (a hand-drawn tab row)', () => {
    const offenders = markup.flatMap(({ file, body }) =>
      [...inlineTabAssignments(body)]
        .filter(([, literals]) => literals.size >= 2)
        .map(([variable, literals]) => `${file}: ${variable} = ${[...literals].join(' | ')}`)
    );
    expect(offenders).toEqual([]);
  });

  it('only the listed owners declare role="tablist", and each owner still does', () => {
    const declaring = markup
      .filter(({ body }) => /role=["']tablist["']/.test(body))
      .map(({ file }) => file)
      .sort();
    expect(declaring).toEqual(Object.keys(TABLIST_OWNERS).sort());
  });

  it('nothing but the overlay stack writes the History API', () => {
    const writers = code
      .filter(({ body }) => /\bhistory\.(pushState|replaceState)\s*\(/.test(body))
      .map(({ file }) => file);
    expect(writers).toEqual([HISTORY_OWNER]);
  });
});
