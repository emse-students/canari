// @vitest-environment happy-dom
/**
 * THE REACH CHIP IS ON THE CARD FOR EVERY READER (owner, 2026-11-10): the server serves `reach` on an
 * institution post to everyone who may read it, and the header draws who it is for and where - the
 * one space by name, several by count, every space in the title.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
// The follow chip's state is its own spec (`FollowChip.svelte.test.ts`); here it must not reach the network.
vi.mock('$lib/follows/followState.svelte', () => ({
  ensureAssociationsLoaded: () => {},
  followEpoch: () => 0,
  retryFailedFollowReads: () => {},
  ensureBlocksLoaded: () => {},
  ensurePersonStatus: () => {},
  personChipState: () => 'hidden',
  associationChipState: () => 'hidden',
  tapPerson: () => Promise.resolve(),
  tapAssociation: () => Promise.resolve(),
}));
import { flushSync, mount, unmount } from 'svelte';
import PostHeader from './PostHeader.svelte';
import type { PostEntity } from '$lib/posts/api';
import type { InstitutionReach } from '$lib/posts/institutionReach';
import { m } from '$lib/paraglide/messages';

vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function header(reach: InstitutionReach | null | undefined) {
  const post: PostEntity = {
    id: 'p1',
    markdown: 'le communiqué',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    associationId: 'inst-1',
    association: { id: 'inst-1', name: 'Mines', slug: 'emse', logoUrl: null, type: 'institution' },
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(reach === undefined ? {} : { reach }),
  } as PostEntity;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostHeader, { target, props: { post } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

const ICM_SE = { formation: 'ICM', campus: 'saint-etienne' };
const ISMIN_GA = { formation: 'ISMIN', campus: 'gardanne' };

describe('PostHeader - the reach chip', () => {
  it('names the public and the one space', () => {
    const chip = header({ spaces: [ICM_SE], public: 'students' }).querySelector(
      '[data-institution-reach-chip]'
    );
    expect(chip?.textContent).toContain(m.post_reach_public_students());
    expect(chip?.textContent).toContain('ICM');
    expect(chip?.getAttribute('title')).toContain(m.post_reach_public_students());
  });

  it('counts several spaces, and lists every one of them in its title', () => {
    const chip = header({ spaces: [ICM_SE, ISMIN_GA], public: 'staff' }).querySelector(
      '[data-institution-reach-chip]'
    );
    expect(chip?.textContent).toContain(m.post_reach_chip_spaces({ count: 2 }));
    expect(chip?.getAttribute('title')).toContain('ICM');
    expect(chip?.getAttribute('title')).toContain('ISMIN');
  });

  it('is absent from a post with no reach, and from a server older than the field', () => {
    expect(header(null).querySelector('[data-institution-reach-chip]')).toBeNull();
    expect(header(undefined).querySelector('[data-institution-reach-chip]')).toBeNull();
  });
});
