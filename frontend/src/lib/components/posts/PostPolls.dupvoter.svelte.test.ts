// @vitest-environment happy-dom
/** A voter id stored twice on an option must not throw each_key_duplicate in the voter list. */
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

describe('PostPolls duplicate stored voter', () => {
  it('draws a voter id stored twice once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poll = {
      id: 'poll',
      question: 'q',
      multipleChoice: false,
      votesByUser: {},
      options: [{ id: 'o1', label: 'one', votes: ['u1', 'u1'] }],
    } as unknown as Poll;
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(PostPolls, {
      target,
      props: {
        polls: [poll],
        selectedOptions: [],
        onVoteClick: () => {},
        onSubmitVote: () => {},
        isOver: () => false,
      },
    });
    mounted.push(() => unmount(app));
    target.querySelector<HTMLElement>('[role="button"][aria-label]')!.click();
    await new Promise<void>((r) => setTimeout(r, 0));
    flushSync();
    expect(document.body.querySelectorAll('[role="tooltip"] li')).toHaveLength(1);
    // The count agrees with the list: one voter, not the two stored rows.
    expect(target.querySelector('[role="button"][aria-label]')!.textContent!.trim()).toBe('1');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
