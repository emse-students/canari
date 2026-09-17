/**
 * A REGULAR READER GETS THE FULLY HIDDEN TREATMENT; A MODERATOR, PLATFORM ADMIN, OR THE POST'S OWN
 * AUTHOR SEES THE REAL IDENTITY PLUS A BADGE.
 *
 * User request, 2026-09-17: *"il faut aussi qu'un moderateur sache qu'un poste a ete publie en
 * anonyme, meme s'il peut voir le nom du posteur - pareil pour le posteur lui-meme quand il voit
 * son post"*. The server (`PostsService.mustHideAnonymousAuthor`) only omits `authorId` for a
 * regular reader - a moderator/admin/self-viewer's payload keeps it - so `PostHeader` branches on
 * `post.authorId` being present, never on `post.anonymous` alone, to decide which treatment to
 * draw. `Avatar`/`AnonymousAvatar` never fetch anything relevant here, so this is a synchronous,
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
  it('shows the generic icon and "Anonyme", never a profile link, for a regular reader (no authorId)', () => {
    const target = renderHeader(basePost({ anonymous: true }));

    expect(target.textContent).toContain('Anonyme');
    expect(target.querySelector('a[href^="/profile/"]')).toBeNull();
  });

  it('shows the REAL name/avatar plus an "Anonyme" badge when authorId is present (moderator, admin, or the author viewing their own post)', () => {
    const target = renderHeader(
      basePost({ anonymous: true, authorId: 'real-author-id', authorFirstName: 'Marie' })
    );

    expect(target.textContent).toContain('Marie');
    expect(target.querySelector('a[href^="/profile/real-author-id"]')).not.toBeNull();
    // The badge, not the fully-hidden label - both currently read "Anonyme", so this checks the
    // profile link is real rather than asserting text absence.
    expect(target.textContent).toContain('Anonyme');
  });

  it('renders a normal profile link and avatar for a non-anonymous personal post', () => {
    const target = renderHeader(basePost({ authorId: 'user-1', authorFirstName: 'Marie' }));

    expect(target.textContent).toContain('Marie');
    expect(target.querySelector('a[href^="/profile/"]')).not.toBeNull();
    expect(target.textContent).not.toContain('Anonyme');
  });
});
