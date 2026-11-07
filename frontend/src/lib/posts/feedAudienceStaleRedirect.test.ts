// @vitest-environment happy-dom
/**
 * AN UNKNOWN VERDICT REDIRECTS BEHIND THE PAGE, BUT ONLY WHILE THE READER IS STILL ON THE FEED.
 * A reader outside the audience who left `/posts` before the answer arrived must not be pulled away
 * from the page they went to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  answer: undefined as undefined | ((v: unknown) => void),
  goto: vi.fn(async (..._a: unknown[]) => {}),
}));

vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => hoisted.goto(...a) }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/user', () => ({ isGlobalAdmin: () => false }));
vi.mock('$lib/posts/api', () => ({
  fetchFeedAudience: () => new Promise((r) => (hoisted.answer = r)),
}));

import { redirectIfNotFeedAudience } from './feedAudience';
import { setFeedAudience } from '$lib/stores/userState.svelte';

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  hoisted.goto.mockClear();
  setFeedAudience(null);
});

describe('the audience redirect behind the page', () => {
  it('sends a reader still on the feed to /chat', async () => {
    window.history.pushState({}, '', '/posts');
    expect(await redirectIfNotFeedAudience()).toBe(false);
    hoisted.answer!({ inAudience: false });
    await flush();
    expect(hoisted.goto).toHaveBeenCalledTimes(1);
    expect(hoisted.goto.mock.calls[0][0]).toBe('/chat');
  });

  it('leaves a reader who went elsewhere before the answer where they are', async () => {
    window.history.pushState({}, '', '/posts');
    await redirectIfNotFeedAudience();
    window.history.pushState({}, '', '/associations');
    hoisted.answer!({ inAudience: false });
    await flush();
    expect(hoisted.goto).not.toHaveBeenCalled();
  });
});
