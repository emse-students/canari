// @vitest-environment happy-dom
/**
 * A POST WHOSE COMMENTS ARE WITHHELD FROM ITS READER DRAWS NO COMMENT CONTROL (owner, 2026-11-04).
 *
 * The server says `canSeeComments: false` to a named reader whose only door to the post is a read
 * grant with "voit les commentaires" off, and sends no comment, no count, and the reactions as the
 * reader's own plus `otherReactionCounts`. The card then shows no comment button, no count, no
 * preview and no thread - nothing hints at a discussion - and the reaction badges count the tally.
 */
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostEntity } from '$lib/posts/api';
import { apiFetch } from '$lib/utils/apiFetch';
import { m } from '$lib/paraglide/messages';
import { adoptTransitionAnimations } from '../../../test/adoptTransitionAnimations';

afterAll(adoptTransitionAnimations());

vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  addReaction: vi.fn(),
  removeReaction: vi.fn(),
  fetchComments: vi.fn(),
}));
vi.mock('$lib/utils/apiFetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/apiFetch')>()),
  apiFetch: vi.fn(),
}));

const mounted: (() => void)[] = [];

beforeEach(() => {
  // Nothing on the card may reach the network unasked: an unexpected call never answers.
  vi.mocked(apiFetch).mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {}))
  );
});

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function row(extra: Partial<PostEntity>): PostEntity {
  return {
    id: 'p1',
    markdown: 'an association speaks',
    mentions: [],
    links: [],
    media: [],
    images: [],
    reactions: {},
    polls: [],
    createdAt: '2026-11-04T08:00:00.000Z',
    publishedAt: '2026-11-04T08:00:00.000Z',
    updatedAt: '2026-11-04T08:00:00.000Z',
    ...extra,
  };
}

function mountCard(post: PostEntity, commentsOpen = false) {
  const target = document.body.appendChild(document.createElement('div'));
  const instance = mount(PostCard, {
    target,
    props: { post, currentUserId: 'reader', commentsOpen },
  });
  mounted.push(() => unmount(instance));
  flushSync();
  return target;
}

const commentButton = (target: HTMLElement) =>
  target.querySelector(`button[aria-label="${m.post_commenter()}"]`);

it('draws no comment button, count, preview or thread when the comments are withheld', () => {
  // A stale row may still carry comments (a cached page from before the switch): never drawn.
  const comments = [
    { id: 'c1', userId: 'student', text: 'a student speaks', createdAt: '2026-11-04T08:00:00Z' },
  ] as unknown as PostEntity['comments'];
  const target = mountCard(
    row({ canSeeComments: false, comments, otherReactionCounts: { "J'aime": 2 } }),
    true
  );
  expect(commentButton(target)).toBeNull();
  expect(document.body.textContent).not.toContain('a student speaks');
  // Opened "with its comments" (a deep link): no thread is mounted either.
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('counts the reactions from the tally plus the reader own one', () => {
  const target = mountCard(
    row({
      canSeeComments: false,
      reactions: { reader: "J'aime" },
      otherReactionCounts: { "J'aime": 2, Triste: 1 },
    })
  );
  const counts = [...target.querySelectorAll('span.font-bold')].map((s) => s.textContent!.trim());
  expect(counts).toEqual(expect.arrayContaining(['3', '1']));
});

it('keeps the comment button and the preview on any other post', () => {
  const comments = [
    { id: 'c1', userId: 'student', text: 'a student speaks', createdAt: '2026-11-04T08:00:00Z' },
  ] as unknown as PostEntity['comments'];
  const target = mountCard(row({ comments, commentCount: 1 }));
  expect(commentButton(target)).not.toBeNull();
  expect(target.textContent).toContain('a student speaks');
});
