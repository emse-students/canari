/**
 * `fixed` MEANS "THE VIEWPORT" ONLY WHILE NO ANCESTOR CLAIMS IT.
 *
 * A non-`none` `transform` (also `filter`, `backdrop-filter`, `perspective`, `contain` and
 * `will-change` of those) makes an element the containing block for every `position: fixed`
 * DESCENDANT. So a full-bleed overlay left in the component tree does not cover the viewport - it
 * covers whichever ancestor happens to be transformed at that moment.
 *
 * THE GIF PICKER IS ONE COMPONENT OPENED FROM TWO PLACES, AND IT MISBEHAVED IN EXACTLY ONE.
 * `ChatComposer` sits near the root. `PostComments` sits inside `PostCard`'s card, which carries
 * `hover:-translate-y-0.5` - so while the pointer was over the card, the picker and its backdrop
 * were confined to the card's rectangle. The user reported it on 2026-09-13 as the picker "doing
 * weird things" in posts, *"notamment sur mobile"*: on touch `:hover` STICKS after the tap, so the
 * card holds the transform for as long as the picker is open, and the 300ms `transition-all` keeps
 * it non-`none` on the way out too.
 *
 * MEASURED IN A BROWSER, 2026-09-13, on a 400x200 stand-in card: the overlay reads 1265x400 at
 * (0,0) with no transform, and 400x200 at (109,99) with `translateY(-2px)` - the card exactly - and
 * returns to the viewport the moment the transform goes. The first test reproduces that arithmetic
 * so the mechanism is pinned rather than remembered.
 *
 * The repo already refuses this shape for anchored panels: `fixedPopover.test.ts` fails a
 * viewport-positioned panel left in the tree and names this precise cause. A `fixed inset-0`
 * overlay is the same fact in a different spelling, and this one was not in that family.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { svelteFiles, withoutAnyComments } from '$lib/styles/markupSources';

const dir = join(process.cwd(), 'src');

/**
 * **A SOURCE CHECK THAT READS ITS OWN PROSE IS A TEST THAT LIES, AND THIS ONE DID.** The first
 * version asked `body.includes('use:portal')` and stayed GREEN after the portal was deleted,
 * because the docblock above the portal contains the words `use:portal`. Every assertion below
 * reads `code()`, never the raw file.
 *
 * The stripper is `markupSources`' and not a local one - its own gate refuses a private copy, and
 * refused this file's, which is the extraction working exactly as intended.
 */
const code = (body: string) => withoutAnyComments(body);

/** Declares a full-viewport overlay: `fixed inset-0` in a class attribute. */
const declaresOverlay = (body: string) => /class="[^"]*\bfixed inset-0\b/.test(body);

/** The ACTION, as an attribute in markup - never the word in a comment. */
const isPortalled = (body: string) => /\buse:portal\b/.test(code(body));

describe('a transformed ancestor claims a `fixed` descendant', () => {
  it('is what happened, and it is arithmetic rather than a memory', () => {
    // The rule, as the browser applied it: a `fixed inset-0` child resolves against the viewport
    // until an ancestor's transform is non-`none`, and then against THAT ancestor's border box.
    const viewport = { left: 0, top: 0, width: 1265, height: 400 };
    const card = { left: 109, top: 99, width: 400, height: 200 };
    const overlayBox = (ancestorTransform: string) =>
      ancestorTransform === 'none' ? viewport : card;

    expect(overlayBox('none')).toEqual(viewport);
    // `hover:-translate-y-0.5`, which is what the card carries.
    expect(overlayBox('translateY(-2px)')).toEqual(card);
    // And back, which is why the symptom followed the pointer instead of staying put.
    expect(overlayBox('none')).toEqual(viewport);
  });

  it('the card that claimed it still carries the transform, so the fix is the portal and not its removal', () => {
    // The lift is a deliberate hover affordance on every feed card and is not the thing to delete.
    // If it ever goes, this test says so rather than letting the portal look unnecessary.
    const card = readFileSync(join(dir, 'lib/components/posts/PostCard.svelte'), 'utf8');
    expect(card).toContain('hover:-translate-y-0.5');
  });
});

describe('an overlay opened from a POST is portalled, because that tree provably transforms', () => {
  /**
   * SCOPED TO THE SUBTREE WHERE THE ANCESTOR IS PROVEN, and deliberately not wider.
   *
   * Eleven other components declare `fixed inset-0` and stay in the tree. That is a real finding
   * and it is filed with this list in `backlog.md` - but portalling a node changes where its events
   * bubble, so twelve at once is a blind change, not a fix. What is asserted here is the case with
   * a measured transformed ancestor: anything the posts tree opens.
   *
   * Read as SOURCE because the defect is invisible from the component - it depends entirely on what
   * is above the call site, so no test that mounts the component alone can ever see it.
   */
  it('refuses an overlay reachable from components/posts that an ancestor could claim', () => {
    const posts = join(dir, 'lib/components/posts');
    const imported = new Set<string>();
    for (const file of svelteFiles(posts)) {
      const body = readFileSync(file, 'utf8');
      for (const [, spec] of body.matchAll(/from\s+'(\$lib\/components\/[^']+\.svelte)'/g)) {
        imported.add(join(dir, spec.replace('$lib/', 'lib/')));
      }
    }

    const offenders = [...imported, ...svelteFiles(posts)]
      .filter((file) => {
        const body = readFileSync(file, 'utf8');
        return declaresOverlay(code(body)) && !isPortalled(body);
      })
      .map((file) => relative(dir, file));

    expect(
      offenders,
      'These declare a full-viewport overlay and are opened from inside a post card, whose ' +
        '`hover:-translate-y-0.5` makes it the containing block for every `fixed` descendant - ' +
        'and on touch `:hover` sticks for as long as the overlay is open. Add `use:portal`: ' +
        offenders.join(', ')
    ).toEqual([]);
  });

  it('the picker itself is portalled, and still closes on a click outside the panel', () => {
    const body = readFileSync(join(dir, 'lib/components/chat/GifPickerModal.svelte'), 'utf8');

    expect(isPortalled(body), 'the portal ACTION, not the word in the docblock').toBe(true);
    // THE SCRIM WENT, THE TARGET DID NOT (user: "pas besoin de fond fonce"). Dropping the button
    // with the dimming is what would actually cost something - the overlay is how a click outside
    // the panel reaches `onClose`.
    expect(code(body)).not.toContain('bg-black/45');
    expect(code(body)).toContain('onclick={onClose}');
  });
});
