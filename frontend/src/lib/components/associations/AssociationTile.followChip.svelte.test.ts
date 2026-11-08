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
  ensureBlocksLoaded: () => {},
  ensurePersonStatus: () => {},
  personChipState: () => null,
  isAssociationFollowed: (id: string) => id === 'followed',
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

function tile(id: string) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const association = { id, name: 'BDE', slug: 'bde', type: 'association' } as Association;
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

  it('offers nothing for an association already followed', () => {
    expect(tile('followed').querySelector('[data-follow-chip]')).toBeNull();
  });
});
