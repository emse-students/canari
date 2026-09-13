/**
 * THE TILE IS ONE IMPLEMENTATION, AND THE TWO DEFECTS IT FIXED CANNOT COME BACK BY COPY.
 *
 * `/associations` and `/lists` drew this card five times between them and every copy `truncate`d the
 * name and cropped the description at a raw `max-h-[2.75rem]`. Fixing five copies is not the fix -
 * the sixth is written the moment somebody adds a shelf - so what is asserted here is that the two
 * pages hold NO hand-rolled tile at all, and that the one tile keeps the three properties that made
 * the fix worth making.
 *
 * Read as SOURCE, and with comments stripped, because a check that reads its own prose is a check
 * that lies - `GifPickerModal.overlay.test.ts` learnt that the expensive way on 2026-09-13.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutAnyComments } from '$lib/styles/markupSources';

const dir = join(process.cwd(), 'src');
const read = (rel: string) => withoutAnyComments(readFileSync(join(dir, rel), 'utf8'));

const TILE = 'lib/components/associations/AssociationTile.svelte';
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

describe('the one tile keeps what the copies did not have', () => {
  const tile = read(TILE);

  it('wraps the name instead of truncating it', () => {
    // Anchored to the HEADING and not to the file: the description clamps to three lines too, so a
    // bare `toContain` here would stay green with the name back on `truncate`.
    expect(tile).toMatch(/<h3 class="[^"]*\bline-clamp-3\b[^"]*"/);
    expect(tile).not.toContain('truncate');
    // The floor under the wrap: a single unbroken token has no break opportunity, and without this
    // it widens its grid column rather than wrapping - which is how a card WALL stops being one.
    expect(tile).toContain('[overflow-wrap:anywhere]');
  });

  it('clamps the description on the container, which is where it was measured to work', () => {
    // Measured in a browser at a 240px column, 2026-09-13: a two-paragraph description renders
    // 114px unclamped, 57px (three lines, both paragraphs considered) clamped HERE, and 95px when
    // the clamp is moved to the first paragraph instead - a truncation that forgot to truncate.
    expect(tile).toMatch(/class="[^"]*\bline-clamp-3\b[^"]*"[\s\S]{0,200}<ProfileBioMarkdown/);
    expect(tile).not.toMatch(/post-markdown_p\]:line-clamp/);
  });

  it("carries the association's colour, with the fallback the rest of the app already gives", () => {
    // `Association.color` has fed the calendar and the Carte de la Vie Asso for months, and
    // `cardGrid.ts` sized its 15rem minimum with "an association's colour bar" in the budget. No
    // tile had ever drawn one.
    expect(tile).toContain('association.color ?? generateAvatarColor(association.name)');
    // Through CardTile, which already implements the accent - a call, never a second copy of it.
    expect(tile).toMatch(/<CardTile[\s\S]{0,120}accentColor=\{accent\}/);
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
