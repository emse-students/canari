/**
 * A CARD TAKES THE SERVER'S ROW WHEN ITS PARENT HANDS IT A NEW ONE FOR THE SAME POST (review of
 * #1896). The feed draws its stored copy first - no rights, `canVote: false` - and the keyed list
 * keeps the card when the server's page replaces the row; the card used to copy its prop once, so
 * the vote stayed refused and the old text stayed drawn for the whole session.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostCard from './PostCard.svelte';
import type { PostEntity } from '$lib/posts/api';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function row(extra: Partial<PostEntity>): PostEntity {
  return {
    id: 'p1',
    markdown: 'stored text',
    mentions: [],
    links: [],
    media: [],
    images: [],
    polls: [
      {
        id: 'poll1',
        question: 'Which one?',
        options: [
          { id: 'o1', label: 'First', votes: [] },
          { id: 'o2', label: 'Second', votes: [] },
        ],
        multipleChoice: false,
        votesByUser: {},
      },
    ],
    createdAt: '2026-10-15T08:00:00.000Z',
    publishedAt: '2026-10-15T08:00:00.000Z',
    updatedAt: '2026-10-15T08:00:00.000Z',
    ...extra,
  };
}

/** The poll's option buttons, by their `aria-disabled`. */
function optionsRefused(target: HTMLElement): string[] {
  return [...target.querySelectorAll('button[aria-pressed]')].map(
    (b) => b.getAttribute('aria-disabled') ?? ''
  );
}

it('a list the feed only re-slices or filters keeps its rows, so a card adopts nothing then', () => {
  // The feed's own edits (`onDelete`'s filter, the infinite scroll's append) reassign the list; the
  // card adopts a row only when its identity changes, so those must keep it - or a reaction the
  // reader already completed would be overwritten by the older row.
  const feed = $state({ list: [row({}), row({ id: 'p2' })] });
  const first = feed.list[0];
  feed.list = feed.list.filter((p) => p.id !== 'p2');
  feed.list = [...feed.list, row({ id: 'p3' })];
  expect(feed.list[0]).toBe(first);
});

it('adopts the served row: the vote opens and the new text is drawn', () => {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const props = $state({ post: row({ canVote: false }), currentUserId: 'alice' });
  const instance = mount(PostCard, { target, props });
  mounted.push(() => unmount(instance));
  flushSync();

  expect(optionsRefused(target)).toEqual(['true', 'true']);
  expect(target.textContent).toContain('stored text');

  // The server's page: the same post, with this reader's rights and the text as it is now.
  props.post = row({ canVote: true, markdown: 'served text' });
  flushSync();

  expect(optionsRefused(target)).toEqual(['false', 'false']);
  expect(target.textContent).toContain('served text');
  expect(target.textContent).not.toContain('stored text');
});
