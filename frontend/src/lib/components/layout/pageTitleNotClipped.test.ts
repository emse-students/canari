import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { allMarkup } from '$lib/styles/markupSources';

/**
 * TRUNCATION IS A LIST AFFORDANCE. A PAGE'S OWN NAME IS NOT A LIST ROW.
 *
 * From the user, 2026-09-14: *"si dans une utilisation normale il y a des choses tronquees, c'est
 * qu'il faudrait revoir la mise en page"* - and the census that followed found **115 `truncate`
 * and 16 `line-clamp`** across 66 components. Nearly all are right: a filename in a picker, a poll
 * option, a message preview, a name in a dense list row. Each is one tap from the full value, and a
 * list whose rows grew to fit their longest entry would be a worse list.
 *
 * **An `<h1>` is the one place it is never right.** It names the page the reader is already on, so
 * there is nothing to tap through to, and the page has a whole column to give it - the text WRAPS,
 * which costs a line and clips nothing. Two carried `truncate` on 2026-09-14, and they are the same
 * header written twice:
 *
 * | | shape | what the name got at 390px |
 * | --- | --- | --- |
 * | `profile/[id]` | `flex-col sm:flex-row` | the whole column |
 * | `profile` | `flex` at every width | **183px** - 96px avatar, 40px of gaps, ~39px of settings link |
 *
 * So one of the two had been fixed and the other never was, which is the shape this repository has
 * a rule about: nothing was wrong at either site on its own, and only a reader holding both files
 * could see it. `/profile` now stacks below `sm` like its sibling, and neither clips.
 *
 * `<h2>` IS DELIBERATELY NOT ASSERTED, and the design reference's truncation-census section says
 * why per site:
 * four remain, and all four are a heading in a bar or a card that has actions beside it on one
 * line, where wrapping moves those actions and the layout jumps on every selection. That is a
 * different question from this one, and a guard that answered both would be answering neither.
 */
const ROOT = process.cwd();

/** `class="..."` values with whitespace collapsed, so an attribute spanning lines is still one. */
function headingClasses(body: string): string[] {
  const flat = body.replace(/\s+/g, ' ');
  const out: string[] = [];
  const heading = /<h1\b([^>]*)>/g;
  let m = heading.exec(flat);
  while (m !== null) {
    out.push(m[1]);
    m = heading.exec(flat);
  }
  return out;
}

/** `truncate` and `line-clamp-N` both clip; only the direction differs. */
const CLIPS = /\b(truncate|line-clamp-\d+)\b/;

describe('a page never clips its own name', () => {
  const markup = allMarkup(join(ROOT, 'src'));

  it('reads the whole markup tree, so the guard is not guarding an empty set', () => {
    expect(markup.length).toBeGreaterThan(200);
    expect(markup.some(({ file }) => file.includes('profile'))).toBe(true);
  });

  it('finds the h1 elements it is meant to be reading', () => {
    const withH1 = markup.filter(({ body }) => headingClasses(body).length > 0);
    expect(withH1.length).toBeGreaterThan(5);
  });

  it('no <h1> anywhere carries truncate or line-clamp', () => {
    const offenders = markup.flatMap(({ file, body }) =>
      headingClasses(body)
        .filter((attrs) => CLIPS.test(attrs))
        .map(() => file)
    );

    expect(offenders).toEqual([]);
  });
});
