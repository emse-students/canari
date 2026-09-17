/**
 * AN ANONYMOUS POST NEVER RESOLVES AN AVATAR FROM AN ID, EVEN WHEN THE VIEWER IS AN ADMIN WHO
 * RECEIVED `authorId` ON THE PAYLOAD.
 *
 * `post.anonymous` is the only signal the header may act on - checking `post.authorId` first
 * would draw a real avatar for a moderator viewing an anonymous post, which is exactly the leak
 * the flag exists to prevent. `AnonymousAvatar` never fetches anything, so this is a synchronous,
 * network-free check.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostHeader from './PostHeader.svelte';
import type { PostEntity } from '$lib/posts/api';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => `User ${id}`,
  resolveUserDisplayName: async (id: string) => `User ${id}`,
}));
vi.mock('$lib/utils/userAvatarCache', () => ({
  resolveUserAvatarDisplayUrl: async () => ({ kind: 'none' as const }),
  releaseUserAvatarDisplayUrl: () => {},
}));

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function basePost(overrides: Partial<PostEntity>): PostEntity {
  return {
    id: 'p1',
    markdown: 'hello',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderHeader(post: PostEntity) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(PostHeader, { target, props: { post } });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

describe('PostHeader anonymous post', () => {
  it('shows the generic icon and "Anonyme", never a profile link, for a regular reader', () => {
    const target = renderHeader(basePost({ anonymous: true }));

    expect(target.textContent).toContain('Anonyme');
    expect(target.querySelector('a[href^="/profile/"]')).toBeNull();
  });

  it('still shows the generic icon even when the viewer is an admin who received authorId', () => {
    // The exact case the flag exists for: an admin's payload keeps `authorId` (for moderation
    // purposes), but the avatar drawn must not depend on that field being present.
    const target = renderHeader(basePost({ anonymous: true, authorId: 'real-author-id' }));

    expect(target.textContent).toContain('Anonyme');
    expect(target.querySelector('a[href^="/profile/"]')).toBeNull();
    expect(target.querySelector('[aria-label^="Avatar de"]')).toBeNull();
  });

  it('renders a normal profile link and avatar for a non-anonymous personal post', () => {
    const target = renderHeader(basePost({ authorId: 'user-1', authorFirstName: 'Marie' }));

    expect(target.textContent).toContain('Marie');
    expect(target.querySelector('a[href^="/profile/"]')).not.toBeNull();
    expect(target.textContent).not.toContain('Anonyme');
  });
});
