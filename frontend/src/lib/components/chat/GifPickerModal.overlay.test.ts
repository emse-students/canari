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
import { svelteSources, withoutAnyComments } from '$lib/styles/markupSources';
import { readSource, relativeTo } from '../../../test/sourceTree';

const dir = 'src';

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

/**
 * The ACTION, as an attribute in markup - never the word in a comment - OR `<ModalOverlay>`, which
 * applies it unconditionally.
 *
 * **FOLLOWING THE PROPERTY ACROSS A COMPONENT BOUNDARY IS ONLY HONEST BECAUSE THE TEST BELOW PINS
 * THE OTHER SIDE.** When the seven hand-written modal containers were fused, this check went red
 * while the property it exists for was MORE true than before: the picker no longer spells
 * `use:portal` because its overlay does, for every modal in the app at once. A guard anchored to
 * the implementation rather than to the property fails exactly then - on the change that fixes the
 * whole class of defect - which is the moment it is likeliest to be deleted instead of followed.
 */
const isPortalled = (body: string) =>
  /\buse:portal\b/.test(code(body)) || /<ModalOverlay\b/.test(code(body));

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
    const card = readSource(`${dir}/lib/components/posts/PostCard.svelte`);
    expect(card).toContain('hover:-translate-y-0.5');
  });
});

describe('an overlay opened from a POST is portalled, because that tree provably transforms', () => {
  /**
   * SCOPED TO THE SUBTREE WHERE THE ANCESTOR IS PROVEN, and deliberately not wider.
   *
   * This was scoped to the posts subtree while the picker was the only thing fixed, because
   * portalling a node changes where its events bubble and twelve at once would have been a blind
   * change. Seven of those have since been fused into `ModalOverlay`, which portals all of them -
   * so the scope stays as it is not because the rest are unfixed but because THIS is the case with
   * a MEASURED transformed ancestor. The others are covered by construction, not by proof.
   *
   * What still declares `fixed inset-0` by hand is a different KIND: `FullScreenViewer` and
   * `CallOverlay` are full-page surfaces rather than modals, and a nav or side-panel scrim is
   * anchored to its nav on purpose.
   *
   * Read as SOURCE because the defect is invisible from the component - it depends entirely on what
   * is above the call site, so no test that mounts the component alone can ever see it.
   */
  it('refuses an overlay reachable from components/posts that an ancestor could claim', () => {
    const posts = svelteSources(`${dir}/lib/components/posts`);
    // The tree the scan thinks it reads: a wrong root would leave both loops below empty.
    expect(posts.map((f) => f.path)).toContain(`${dir}/lib/components/posts/PostCard.svelte`);
    const imported = new Set<string>();
    for (const { text } of posts) {
      for (const [, spec] of text.matchAll(/from\s+'(\$lib\/components\/[^']+\.svelte)'/g)) {
        imported.add(`${dir}/${spec.replace('$lib/', 'lib/')}`);
      }
    }

    const offenders = [...[...imported].map((path) => ({ path, text: readSource(path) })), ...posts]
      .filter(({ text }) => declaresOverlay(code(text)) && !isPortalled(text))
      .map(({ path }) => relativeTo(path, dir));

    expect(
      offenders,
      'These declare a full-viewport overlay and are opened from inside a post card, whose ' +
        '`hover:-translate-y-0.5` makes it the containing block for every `fixed` descendant - ' +
        'and on touch `:hover` sticks for as long as the overlay is open. Add `use:portal`: ' +
        offenders.join(', ')
    ).toEqual([]);
  });

  it('the picker itself is portalled, and still closes on a click outside the panel', () => {
    const body = readSource(`${dir}/lib/components/chat/GifPickerModal.svelte`);

    expect(isPortalled(body), 'the portal ACTION, not the word in the docblock').toBe(true);
    // THE SCRIM WENT, THE TARGET DID NOT (user: "pas besoin de fond fonce"). Dropping the plate
    // with the dimming is what would actually cost something - it is how a click outside the panel
    // reaches `onClose`, and on a phone there is no Escape key to fall back on. `scrim={false}` is
    // the colour going; the plate stays.
    expect(code(body)).not.toContain('bg-black/45');
    expect(code(body)).toContain('scrim={false}');
    // Either spelling - Svelte shorthands `onClose={onClose}` to `{onClose}` and the formatter
    // applies it, so pinning the long form would be pinning the formatter.
    expect(code(body)).toMatch(/<ModalOverlay[^>]*(\{onClose\}|onClose=\{onClose\})/);
  });

  it('ModalOverlay portals unconditionally, which is the other half of following the property', () => {
    const overlay = readSource(`${dir}/lib/components/shared/ModalOverlay.svelte`);

    expect(/\buse:portal\b/.test(code(overlay)), 'the ACTION, not the docblock').toBe(true);
    // AND NO PROP TURNS IT OFF. A portal a caller may decline is a portal a caller WILL decline -
    // `PollComposerModal` is the proof: it carried this exact defect, unmet, the whole time the GIF
    // picker's copy of it was being reported. There is a `scrim` prop because a scrim is a LOOK;
    // there is no `portal` prop because a portal is a correctness property.
    expect(code(overlay)).not.toMatch(/portal\s*[?&]|\{#if[^}]*\bportal\b/i);
  });
});
