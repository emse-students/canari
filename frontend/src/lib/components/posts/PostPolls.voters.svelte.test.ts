// @vitest-environment happy-dom
/**
 * Two voters may share a display name; the voter list must still draw both, once each.
 *
 * Keying the tooltip rows by NAME repeated the key and threw `each_key_duplicate` in the card on
 * hover or tap of a vote count. Rows are keyed by voter id.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostPolls from './PostPolls.svelte';
import type { Poll } from '$lib/posts/api';

vi.mock('$lib/utils/users/displayName', () => ({
  getUserDisplayNameSync: (id: string) => id,
  resolveUserDisplayName: async () => 'Alex Martin',
}));

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

describe('PostPolls voter tooltip', () => {
  it('draws two homonym voters as two rows without a duplicate key', async () => {
    const poll = {
      id: 'poll',
      question: 'q',
      multipleChoice: false,
      votesByUser: {},
      options: [{ id: 'o1', text: 'one', votes: ['u1', 'u2'] }],
    } as unknown as Poll;
    const target = document.createElement('div');
    document.body.appendChild(target);
    const component = mount(PostPolls, {
      target,
      props: {
        polls: [poll],
        selectedOptions: [],
        onVoteClick: () => {},
        onSubmitVote: () => {},
        isOver: () => false,
      },
    });
    mounted.push(() => unmount(component));
    const badge = target.querySelector<HTMLElement>('[role="button"][aria-label]')!;
    badge.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    flushSync();
    const rows = [...document.body.querySelectorAll('[role="tooltip"] li')];
    expect(rows.map((r) => r.textContent)).toEqual(['Alex Martin', 'Alex Martin']);
  });
});
