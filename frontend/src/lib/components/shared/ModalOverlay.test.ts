/**
 * NOBODY HAND-ROLLS A MODAL CONTAINER, AND THE COUNT IS WHY.
 *
 * The backlog row that asked for this named THREE duplicates. Converting them found SEVEN, in five
 * files: `AssociationDocumentManager` carries three byte-identical copies in one file, and
 * `ConfirmDialog` - the most complete of them, and the only one with safe-area padding or a working
 * Escape - was not on the list at all. Same shape as the width sweep's "a count of routes is not a
 * count of page columns": a sweep that counts FILES cannot see three copies inside one.
 *
 * **THEY WERE NOT SEVEN COPIES OF ONE DECISION.** Each had independently decided a different subset
 * of what a modal owes, and every gap was invisible on a desktop, where all seven look identical
 * when you open them:
 *
 * - `routes/admin/agenda` used a raw `z-50`, which is not a rung of the ladder in `app.css` - it
 *   lands between `--z-page-overlay` (40) and `--z-toast` (60), so a reject dialog opened
 *   UNDERNEATH a toast.
 * - `PollComposerModal` was not portalled, which is exactly the defect the user reported about the
 *   GIF picker on 2026-09-13. It is opened from the channel composer, near the root, so nobody had
 *   met it - a latent defect, not a working one.
 * - Only `ConfirmDialog` bound Escape, and only it padded for the home indicator.
 *
 * So the assertions below are about the PROPERTY, spread over a tree, not about one component's
 * render. A unit test that mounted `ModalOverlay` would have passed on every day the seven
 * disagreed, which is the same reason `associations/accent.test.ts` walks the tree.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { svelteFiles, withoutAnyComments } from '$lib/styles/markupSources';

const dir = join(process.cwd(), 'src');
const code = (body: string) => withoutAnyComments(readFileSync(body, 'utf8'));

/** The overlay itself, and the two full-page surfaces that are deliberately NOT modals. */
const OVERLAY = join(dir, 'lib/components/shared/ModalOverlay.svelte');
/**
 * AN ALLOWLIST, NAMED, WITH A REASON EACH - never a denylist.
 *
 * `CallOverlay` is the call itself, opaque and `flex-col`, and it replaces the page rather than
 * sitting over it. `FullScreenViewer` is a media viewer with its own pinch-zoom touch handling.
 * Neither is a panel centred on a scrim, and folding either into `ModalOverlay` would be the
 * call-sites error in CSS: the same markup does not make them the same thing.
 */
const NOT_MODALS = [
  join(dir, 'lib/components/chat/CallOverlay.svelte'),
  join(dir, 'lib/components/shared/FullScreenViewer.svelte'),
];

/** A panel CENTRED on a full-viewport plate - which is what "a modal" means in markup. */
const centresAPanel = (body: string) =>
  /class="[^"]*\bfixed inset-0\b[^"]*\bjustify-center\b/.test(body);

describe('one overlay for every modal', () => {
  it('is the only thing that centres a panel on a full-viewport plate', () => {
    const offenders = svelteFiles(dir)
      .filter((file) => file !== OVERLAY && !NOT_MODALS.includes(file))
      .filter((file) => centresAPanel(code(file)))
      .map((file) => relative(dir, file));

    expect(
      offenders,
      'These hand-roll a modal container. Seven did, and no two agreed on the layer, the portal, ' +
        'Escape or the safe area - use <ModalOverlay>: ' +
        offenders.join(', ')
    ).toEqual([]);
  });

  it('sees the shape it forbids, so it is not a pattern that matches nothing', () => {
    // A predicate never shown a positive is a predicate nobody has tested. This is `admin/agenda`'s
    // old root, character for character.
    expect(
      centresAPanel(
        '<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">'
      )
    ).toBe(true);
    // And a scrim behind a drawer is NOT a modal container - it centres nothing. Five of those stay
    // hand-written on purpose; merging them would be the call-sites error in CSS.
    expect(centresAPanel('<div class="fixed inset-0 z-(--z-nav-scrim) bg-black/10">')).toBe(false);
  });

  it('names its layer instead of picking a number, and the names are rungs of the real ladder', () => {
    const overlay = code(OVERLAY);
    const css = readFileSync(join(dir, 'app.css'), 'utf8');

    // Tailwind scans source TEXT, so `z-(--z-${layer})` would compile to nothing and the modal
    // would sit at `auto`. The three literals being present is what lets the caller be dynamic.
    for (const token of ['--z-sheet', '--z-modal', '--z-critical']) {
      expect(overlay, `${token} must be spelled out for Tailwind to emit it`).toContain(
        `z-(${token})`
      );
      expect(css, `${token} must be a real rung, not an invented name`).toContain(`${token}:`);
    }
    // AND NO RAW NUMBER. `z-50` is how the agenda's dialog ended up under a toast.
    expect(overlay).not.toMatch(/class="[^"]*\bz-\d+\b/);
  });

  it('keeps the click-to-close plate even when the scrim is not tinted', () => {
    // The user asked for the GIF picker's dark backdrop to go (2026-09-13, *"pas besoin de fond
    // fonce"*). `scrim={false}` drops the COLOUR; dropping the ELEMENT would take the only way to
    // dismiss a modal on a phone, where there is no Escape key. So the tint is conditional and the
    // plate is not.
    const overlay = code(OVERLAY);
    const plate = overlay.slice(overlay.indexOf('role="presentation"'));

    expect(plate).toContain('onclick=');
    // The tint is the only thing the flag may reach.
    expect(overlay).toMatch(/scrim[\s\S]{0,80}bg-black\/40/);
  });

  it('gives every modal an accessible name, because an unnamed dialog is announced as "dialog"', () => {
    const callers = svelteFiles(dir).filter((file) => /<ModalOverlay\b/.test(code(file)));
    // The fusion is the point: if this ever reads a small number again, sites have been written by
    // hand instead.
    expect(callers.length).toBeGreaterThanOrEqual(5);

    // TWO THINGS THIS SPELLING HAD TO GET RIGHT, AND THE FIRST DRAFT MISSED BOTH.
    //
    // NOT `<ModalOverlay[^>]*label=`: a prop like `onClose={() => ...}` contains a `>`, which ends
    // that character class early and reports a labelled modal as unnamed.
    //
    // NOT `\blabel=` either: `\b` matches between the `-` and the `l` of `aria-label=`, so a panel
    // with any labelled input inside it satisfied the check. Deleting the real `label` left this
    // GREEN - caught by planting exactly that, which is the only way a vacuous predicate is ever
    // found. `(?<![\w-])` is what makes `aria-label` stop counting.
    const unnamed = callers
      .filter((file) => {
        const body = code(file);
        const tags = body.match(/<ModalOverlay\b/g)?.length ?? 0;
        const labelled = body.match(/<ModalOverlay\b[\s\S]{0,800}?(?<![\w-])label=/g)?.length ?? 0;
        return labelled < tags;
      })
      .map((file) => relative(dir, file));
    expect(unnamed, `these open a dialog with no accessible name: ${unnamed.join(', ')}`).toEqual(
      []
    );
  });
});
