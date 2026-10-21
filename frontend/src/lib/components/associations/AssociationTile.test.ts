/**
 * THE TILE IS ONE IMPLEMENTATION, AND THE TWO DEFECTS IT FIXED CANNOT COME BACK BY COPY.
 *
 * `/associations` and `/lists` drew this card five times between them and every copy `truncate`d the
 * name and cropped the description at a raw `max-h-[2.75rem]`. Fixing five copies is not the fix -
 * the sixth is written the moment somebody adds a shelf - so what is asserted here is that the two
 * pages hold NO hand-rolled tile at all. What the one tile keeps is RENDERED in
 * `AssociationTile.render.svelte.test.ts` (WP-T5).
 *
 * WHY A SOURCE TEST (WP-T5: keep). The defect is a SIXTH COPY written into a route page, and a
 * rendered page cannot say whether its card came from the tile or from a lookalike assembled beside
 * it. Read with comments stripped, because a check that reads its own prose is a check that lies -
 * `GifPickerModal.overlay.test.ts` learnt that the expensive way on 2026-09-13.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '$lib/styles/markupSources';

const dir = join(process.cwd(), 'src');
const read = (rel: string) => withoutAnyComments(readFileSync(join(dir, rel), 'utf8'));

/** The two walls of association cards. Both are the user's 2026-09-13 report. */
const WALLS = ['routes/associations/+page.svelte', 'routes/lists/+page.svelte'];

describe('the association walls hold no tile of their own', () => {
  it.each(WALLS)('%s renders AssociationTile and assembles nothing itself', (wall) => {
    const body = read(wall);

    expect(body).toContain('AssociationTile');
    // The pieces a hand-rolled tile is made of. A page that imports these again is building a
    // sixth copy, whatever it looks like - and both of these WERE imported here until this change.
    expect(body).not.toContain('AssociationAvatar');
    expect(body).not.toContain('ProfileBioMarkdown');
  });

  it.each(WALLS)('%s truncates no name and crops no description by pixel height', (wall) => {
    const body = read(wall);

    // `truncate` cuts a PROPER NOUN mid-word with no way to read the rest.
    expect(body).not.toContain('truncate');
    // A raw pixel height against a line box whose height it does not know slices a line in half.
    expect(body).not.toMatch(/max-h-\[[\d.]+rem\][^"]*overflow-hidden/);
  });
});

describe("CardTile's header is optional, and only because a caller needs no header", () => {
  const card = read('lib/components/shared/CardTile.svelte');

  it('drops the whole row rather than leaving an empty frame', () => {
    // The tile puts an AssociationAvatar beside the name - it falls back to INITIALS, where
    // CardTile's frame falls back to a generic glyph, and an association with no logo would lose
    // the one mark that tells it apart. So the header has to be absent, not empty.
    expect(card).toMatch(/\{#if trimmedBadge \|\| resolvedIconUrl \|\| FallbackIcon\}/);
    expect(card).toContain('fallbackIcon?: Component');
  });

  it('still renders the frame for every caller that passes an icon', () => {
    // Four callers pass `fallbackIcon` and must be untouched by the prop going optional.
    expect(card).toMatch(/\{#if resolvedIconUrl \|\| FallbackIcon\}/);
    expect(card).toMatch(/\{:else if FallbackIcon\}/);
  });
});
