/**
 * What a LIST's card says, and what it stopped saying (user, 2026-09-22).
 *
 * Three asks, all about the same card, and all of them about not repeating something the page
 * already says:
 *
 * - **the "Liste 2026" pill is gone** - *"c'est deja dans Campagnes 2026, pourquoi doubler ?"* The
 *   shelf heading above the card carries the year, so the pill was a second copy of it on every
 *   card of that shelf.
 * - **the member count is gone FROM LISTS ONLY.** `/associations` keeps it: an association's card
 *   is read to find out how big it is, a list's is read to find a campaign, and "0 membres" on a
 *   list whose members are not registered yet answers nothing. The tile is shared between the two
 *   pages, so this is a condition rather than a deletion.
 * - **the second theme renders small, under both main ones** - a campaign list can run two at
 *   once, and the second one is subordinate.
 *
 * Read from the markup rather than rendered because each of these is a CLASS: every one of them
 * was valid markup that rendered without complaint, and the tile has five call sites between the
 * two directories.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { withoutComments } from '$lib/styles/markupSources';

const TILE = 'src/lib/components/associations/AssociationTile.svelte';
const markup = () => withoutComments(readFileSync(TILE, 'utf8'));

describe('a list card repeats nothing its shelf already says', () => {
  it('draws no promo pill', () => {
    const src = markup();
    expect(src).not.toContain('assoc_list_promo_badge');
    expect(src).not.toContain('assoc_list_type_badge');
  });

  it('shows the member count only where the row is not a list', () => {
    const src = markup();
    // The count must be behind the discriminator, not behind nothing and not behind `isList`.
    expect(src).toContain('const showsMemberCount = $derived(!isList);');
    expect(src).toContain('{#if showsMemberCount}');
    expect(src).toContain('assoc_member_count_many');
  });

  it('keeps the archived and member notes on both kinds', () => {
    // They answer something the shelf does not, so removing the count must not take them with it.
    const src = markup();
    expect(src).toContain('assoc_list_archived_badge');
    expect(src).toContain('assoc_list_member_badge');
  });
});

describe('a list card shows its second theme beneath the main one', () => {
  it('draws it when EITHER half is present', () => {
    // A list can be renamed before its second logo is uploaded, and the logo can land before the
    // name is decided. Requiring both would hide whichever arrived first.
    expect(markup()).toContain(
      'const hasSecondTheme = $derived(Boolean(secondName) || Boolean(secondLogoUrl));'
    );
  });

  it('draws it smaller than the main logo', () => {
    const src = markup();
    expect(src).toContain('size="lg"'); // the main one
    expect(src).toContain('size="sm"'); // the second, 24px against 48px
  });

  it('reads the second logo through the one derivation', () => {
    // Never `/api/media/public/${id}` written out again: two surfaces render it, and a path
    // spelled twice is a path that can disagree with itself.
    const src = markup();
    expect(src).toContain('associationSecondLogoSrc(association.logoMediaId2)');
    expect(src).not.toContain('/api/media/public/');
  });

  it('never labels the second theme with the main name', () => {
    // The fallback exists for the AVATAR's initials only - a label falling back would print the
    // same name twice, one under the other.
    expect(markup()).toContain('{#if secondName}');
  });

  it('shows nothing of the second theme on a regular association', () => {
    // Asserted on the SHAPE, with whitespace collapsed: the formatter wraps these declarations
    // differently as they grow, and a gate a reformat can break teaches its reader to edit it.
    const src = markup().replace(/\s+/g, ' ');
    expect(/const secondName = \$derived\( ?isList \?/.test(src)).toBe(true);
    expect(/const secondLogoUrl = \$derived\( ?isList \?/.test(src)).toBe(true);
    // Both fall back to the EMPTY answer off a list, which is what keeps the block undrawn there.
    expect(src).toContain("association.name2?.trim() ?? '') : ''");
    expect(src).toContain('associationSecondLogoSrc(association.logoMediaId2) : null');
  });
});
