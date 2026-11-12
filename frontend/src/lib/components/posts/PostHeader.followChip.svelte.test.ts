// @vitest-environment happy-dom
/**
 * "SUIVRE" IN A POST HEADER (engagement WP-2): which publisher the chip is offered for. Whether the
 * chip DRAWS (followed, blocked, yourself) is the chip's own spec (`FollowChip.svelte.test.ts`);
 * here the state is stubbed open and only the target is asked.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

vi.mock('$lib/follows/followState.svelte', () => ({
  ensureAssociationsLoaded: () => {},
  followEpoch: () => 0,
  retryFailedFollowReads: () => {},
  ensureBlocksLoaded: () => {},
  ensurePersonStatus: () => {},
  personChipState: () => null,
  associationChipState: () => false,
  tapPerson: () => Promise.resolve(),
  tapAssociation: () => Promise.resolve(),
}));
vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplay: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplay: () => {},
}));

import PostHeader from './PostHeader.svelte';
import type { PostEntity } from '$lib/posts/api';
import { m } from '$lib/paraglide/messages';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function header(overrides: Partial<PostEntity>, showFollow = true) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const post = {
    id: 'p1',
    markdown: 'hello',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    createdAt: new Date().toISOString(),
    publishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as PostEntity;
  const app = mount(PostHeader, { target, props: { post, showFollow } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('PostHeader follow chip', () => {
  it('offers the author of a personal post', () => {
    const chip = header({ authorId: 'u1', authorFirstName: 'Marie' }).querySelector(
      '[data-follow-chip="user"]'
    );
    expect(chip).not.toBeNull();
  });

  it('offers the association of an association post, not a person', () => {
    const t = header({
      association: { id: 'a1', name: 'BDE', slug: 'bde', logoUrl: null },
    } as Partial<PostEntity>);
    expect(t.querySelector('[data-follow-chip="association"]')).not.toBeNull();
    expect(t.querySelector('[data-follow-chip="user"]')).toBeNull();
  });

  it('offers nothing in the moderation preview (showFollow off)', () => {
    expect(
      header({ authorId: 'u1', authorFirstName: 'Marie' }, false).querySelector(
        '[data-follow-chip]'
      )
    ).toBeNull();
  });

  it('is a quiet text link on the meta line under the name, after the time', () => {
    const t = header({ authorId: 'u1', authorFirstName: 'Marie' });
    const line = t.querySelector('[data-post-time-line]')!;
    const link = line.querySelector('[data-follow-chip="user"]')!;
    expect(link.tagName).toBe('BUTTON');
    expect(link.getAttribute('data-follow-chip-variant')).toBe('link');
    expect(link.querySelector('svg')).toBeNull();
    expect(line.textContent).toContain('·');
    // nothing of it on the right of the header, where only the action row sits
    expect(t.querySelectorAll('[data-follow-chip]')).toHaveLength(1);
  });

  it('marks a suggested post with a muted word on the same line, not a badge', () => {
    const t = header({ authorId: 'u1', feedSuggested: true } as Partial<PostEntity>);
    const mark = t.querySelector('[data-post-time-line] [data-post-suggestion]')!;
    expect(mark.textContent).toContain(m.suggestion_post_badge());
    expect(
      t.querySelector('[data-post-time-line]')!.textContent!.indexOf(m.suggestion_post_badge())
    ).toBeLessThan(
      t.querySelector('[data-post-time-line]')!.textContent!.indexOf(m.profile_public_follow_btn())
    );
    expect(header({ authorId: 'u1' }).querySelector('[data-post-suggestion]')).toBeNull();
  });

  it('offers nothing on an anonymous post, even one whose author the reader may see', () => {
    expect(header({ anonymous: true }).querySelector('[data-follow-chip]')).toBeNull();
    expect(
      header({ anonymous: true, authorId: 'u1' }).querySelector('[data-follow-chip]')
    ).toBeNull();
  });
});
