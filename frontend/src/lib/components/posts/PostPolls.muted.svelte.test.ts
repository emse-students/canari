// @vitest-environment happy-dom
/**
 * A MUTED ACCOUNT IS SERVED `canVote: false` (the mute refuses a vote, decision 9): the poll draws its
 * options as refused, so no tap ends in a server refusal.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import PostPolls from './PostPolls.svelte';
import type { Poll } from '$lib/posts/api';

const mounted: (() => void)[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

function optionsFor(canVote: boolean): HTMLElement[] {
  const poll = {
    id: 'poll',
    question: 'q',
    multipleChoice: false,
    votesByUser: {},
    options: [{ id: 'o1', label: 'one', votes: [] }],
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
      canVote,
    },
  });
  mounted.push(() => void unmount(app));
  flushSync();
  return [...target.querySelectorAll<HTMLElement>('[data-poll-option]')];
}

describe('PostPolls - a reader served canVote false (a muted account)', () => {
  it('draws every option refused', () => {
    const options = optionsFor(false);
    expect(options).toHaveLength(1);
    expect(options[0].getAttribute('aria-disabled')).toBe('true');
  });

  it('CONTROL: a reader served canVote true draws it open', () => {
    expect(optionsFor(true)[0].getAttribute('aria-disabled')).toBe('false');
  });
});
