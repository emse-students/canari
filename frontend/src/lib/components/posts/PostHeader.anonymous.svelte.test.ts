// @vitest-environment happy-dom
/**
 * A REGULAR READER GETS THE FULLY HIDDEN TREATMENT; A MODERATOR, PLATFORM ADMIN, OR THE POST'S OWN
 * AUTHOR SEES "ANONYME" AS THE NAME AND THE REAL AUTHOR SMALL UNDER IT (user, 2026-10-24).
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
import { m } from '$lib/paraglide/messages';

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
    publishedAt: new Date().toISOString(),
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
  it('a regular reader (no authorId) sees "Anonyme" alone: no profile link, no author line', () => {
    const target = renderHeader(basePost({ anonymous: true }));

    expect(target.textContent).toContain('Anonyme');
    expect(target.querySelector('a[href^="/profile/"]')).toBeNull();
    expect(target.querySelector('[data-revealed-author]')).toBeNull();
  });

  it('a reader served the authorId (moderator, admin, the author) sees "Anonyme" big and the real name small under it', () => {
    const target = renderHeader(
      basePost({
        anonymous: true,
        authorId: 'real-author-id',
        authorFirstName: 'Marie',
        authorLastName: 'Curie',
      })
    );

    // The name position says "Anonyme", and it is not a link to anyone.
    const name = target.querySelector('.text-sm.font-bold')!;
    expect(name.textContent!.trim()).toBe('Anonyme');
    expect(name.closest('a')).toBeNull();
    // The real author is the small line under it, linking the profile.
    const line = target.querySelector('[data-revealed-author="real-author-id"]')!;
    expect(line).not.toBeNull();
    expect(line.classList.contains('text-2xs')).toBe(true);
    expect(line.querySelector('a[href="/profile/real-author-id"]')).not.toBeNull();
    expect(line.textContent).toContain('User real-author-id');
    // The line comes before the time's line, under the name.
    const time = target.querySelector('[data-post-time-line]')!;
    expect(line.compareDocumentPosition(time) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a normal profile link and avatar for a non-anonymous personal post', () => {
    const target = renderHeader(basePost({ authorId: 'user-1', authorFirstName: 'Marie' }));

    expect(target.textContent).toContain('Marie');
    expect(target.querySelector('a[href^="/profile/"]')).not.toBeNull();
    expect(target.textContent).not.toContain('Anonyme');
    expect(target.querySelector('[data-revealed-author]')).toBeNull();
  });
});

describe('PostHeader republication', () => {
  it('says "Republie par X" on the line of the time, not on a line of its own', () => {
    const target = renderHeader(
      basePost({
        authorId: 'user-1',
        authorFirstName: 'Marie',
        republishedBy: [{ id: 'a1', name: 'BDE', slug: 'bde', logoUrl: null }],
      } as Partial<PostEntity>)
    );

    const time = target.querySelector('[data-post-time-line]')!;
    expect(time.querySelector('[data-post-republished-by]')!.textContent).toContain(
      m.post_republished_by({ names: 'BDE' })
    );
    // Two glyphs on the line, the clock and the repost: both decoration.
    const repost = time.querySelectorAll('svg')[1];
    expect(repost.getAttribute('aria-hidden')).toBe('true');
  });

  it('draws nothing beside the time when nobody republished the post', () => {
    const target = renderHeader(basePost({ authorId: 'user-1' }));
    expect(target.querySelector('[data-post-republished-by]')).toBeNull();
  });
});
