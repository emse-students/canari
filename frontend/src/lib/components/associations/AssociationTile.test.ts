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

  it("says the reader's role where it knows one, in place of a count it was never given", () => {
    // `/api/associations/me/list` (`listByUser`) returns `role` and NO `memberCount`, so the
    // footer's `memberCount ?? 0` printed "0 membres" on every card of "Mes associations" - about
    // associations the reader IS a member of, and one section above the real count of the same
    // association. The role is what that section is about, so it REPLACES the count.
    const roleBranch = tile.indexOf('{#if association.role}');
    const countBranch = tile.indexOf('assoc_member_count_many');
    expect(roleBranch).toBeGreaterThan(-1);
    expect(countBranch).toBeGreaterThan(roleBranch);
    // The count is the ELSE of the role and never its neighbour - `{:else}` sits between the two.
    const roleFooter = tile.slice(roleBranch, countBranch);
    expect(roleFooter).toContain('{:else}');
    // And the count survives untouched where no role is known: the other wall, the archived fold
    // and both list shelves all draw this same tile, and none of them is told a role.
    expect(tile).toContain('assoc_list_member_badge');
    // ONCE, and BELOW the description: the pill MOVED out of the header rather than being copied
    // into the footer, which is why the header's badge row now carries the TYPE alone.
    expect(tile.split('{association.role}')).toHaveLength(2);
    expect(tile.indexOf('{association.role}')).toBeGreaterThan(tile.indexOf('ProfileBioMarkdown'));
    // The same yellow pill as before, still pinned to the bottom of the card: `mt-auto` is what
    // lines a row's footers up instead of leaving them at five different heights.
    expect(roleFooter).toContain('mt-auto');
    expect(roleFooter).toContain('bg-cn-yellow/20');
  });

  it("carries the association's colour, with the fallback the rest of the app already gives", () => {
    // `Association.color` has fed the calendar and the Carte de la Vie Asso for months, and
    // `cardGrid.ts` sized its 15rem minimum with "an association's colour bar" in the budget. No
    // tile had ever drawn one.
    // Through the ONE derivation since 2026-09-14, and this assertion is why that mattered: it used
    // to pin `association.color ?? generateAvatarColor(association.name)` - a spelling seeded on the
    // NAME, where the calendar seeds on the ID. The test was green and the app showed one
    // association two hues. See `lib/associations/accent.ts`.
    expect(tile).toContain('associationAccent(association)');
    expect(tile).not.toContain('generateAvatarColor');
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
