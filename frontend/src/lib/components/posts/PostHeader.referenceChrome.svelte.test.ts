// @vitest-environment happy-dom
/**
 * THE POST HEADER AS THE REFERENCE DRAWS IT (design audit, 2026-11-09): a pinned post is a muted word on the time line, never a sticker, the time carries no clock glyph and the avatar is a 40 dp tile. The
 * header draws all of it from the post alone.
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

function header(pinned: boolean) {
  const post: PostEntity = {
    id: 'p1',
    markdown: 'la soirée',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    associationId: 'list-1',
    association: { id: 'list-1', name: 'Liste Kraken', slug: 'kraken', logoUrl: null },
    republishedBy: [{ id: 'bde', name: 'BDE', slug: 'bde', logoUrl: null }],
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    pinned,
  } as PostEntity;
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostHeader, { target, props: { post } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('PostHeader - the reference chrome', () => {
  it('draws a pinned post as a muted word beside the time, with no clock glyph', () => {
    const line = header(true).querySelector('[data-post-time-line]')!;
    expect(line.querySelector('[data-post-pinned]')?.textContent?.trim()).toBe(m.post_pinned());
    expect(line.querySelector('.lucide-clock')).toBeNull();
  });

  it('draws nothing for an unpinned post', () => {
    expect(header(false).querySelector('[data-post-pinned]')).toBeNull();
  });

  it('holds the avatar in a 40 dp tile', () => {
    const tile = header(false).querySelector('.h-10.w-10');
    expect(tile).not.toBeNull();
  });
});
