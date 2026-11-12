// @vitest-environment happy-dom
/** "SUIVRE" ON AN ASSOCIATION CARD (engagement WP-2): beside the link, never inside it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/utils/associationLogoCache', () => ({
  resolveAssociationLogoDisplayUrl: (url: string) => Promise.resolve(url),
  releaseAssociationLogoDisplayUrl: () => {},
}));
vi.mock('$lib/follows/followState.svelte', () => ({
  ensureAssociationsLoaded: () => {},
  followEpoch: () => 0,
  retryFailedFollowReads: () => {},
  ensureBlocksLoaded: () => {},
  ensurePersonStatus: () => {},
  personChipState: () => null,
  associationChipState: (id: string) =>
    id === 'followed' || id === 'member' ? (id === 'member' ? 'hidden' : true) : false,
  tapPerson: () => Promise.resolve(),
  tapAssociation: () => Promise.resolve(),
}));

import AssociationTile from './AssociationTile.svelte';
import type { Association } from '$lib/associations/api';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function tile(id: string, extra: Partial<Association> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const association = {
    id,
    name: 'BDE',
    slug: 'bde',
    type: 'association',
    ...extra,
  } as Association;
  const app = mount(AssociationTile, { target, props: { association, href: '/associations/bde' } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('AssociationTile follow chip', () => {
  it('offers Suivre for an association not followed, outside the link', () => {
    const t = tile('a1');
    const chip = t.querySelector('[data-follow-chip="association"]');
    expect(chip).not.toBeNull();
    expect(chip!.closest('a')).toBeNull();
  });

  it('offers nothing for an association the reader belongs to, nor an archived one', () => {
    expect(tile('member').querySelector('[data-follow-chip]')).toBeNull();
    expect(tile('a2', { archived: true }).querySelector('[data-follow-chip]')).toBeNull();
  });

  it('puts the chip INSIDE the card, in its footer row, above the stretched link', () => {
    const t = tile('a1');
    const chip = t.querySelector('[data-follow-chip]')!;
    const link = t.querySelector('a')!;
    expect(link.contains(chip)).toBe(false);
    const card = t.querySelector('.card-tile')!;
    expect(card.contains(chip)).toBe(true);
    expect(link.classList.contains('after:absolute')).toBe(true);
    const wrapper = chip.closest('.relative.z-10')!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.parentElement!.classList.contains('mt-auto')).toBe(true);
    // No row under the card: the tile's outer box holds the card alone, so a row's cards stay one height.
    expect(card.parentElement!.children).toHaveLength(1);
  });

  it('offers nothing for an association already followed', () => {
    expect(tile('followed').querySelector('[data-follow-chip]')).toBeNull();
  });
});
