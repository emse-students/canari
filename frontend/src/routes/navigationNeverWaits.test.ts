/**
 * NAVIGATION NEVER WAITS ON DATA (WP-NAV-1, 2026-10-10). A tap on a weak link must show the next page
 * at once. Pinned for the two loads that used to hold it: the root layout (a profile round trip
 * before EVERY page while the session was not unlocked) and the post page (its own GET). Each
 * `load` must RESOLVE while its network call is still pending.
 */
import { describe, expect, it, vi } from 'vitest';

const pending = () => new Promise<never>(() => {});
const fetchUserProfile = vi.fn(pending);
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  fetchUserProfile: () => fetchUserProfile(),
  UserProfileFetchError: class extends Error {},
}));
vi.mock('$lib/stores/auth', () => ({ refresh: pending }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: false, isLoginInProgress: false },
}));
const getPost = vi.fn(pending);
vi.mock('$lib/posts/api', () => ({ getPost: () => getPost() }));
vi.mock('$lib/posts/feedAudience', () => ({ redirectIfNotFeedAudience: async () => false }));

/** Resolves to 'done' if the promise settles first, 'blocked' if the macrotask queue wins. */
async function settlesPromptly(p: Promise<unknown>): Promise<'done' | 'blocked'> {
  return Promise.race([
    p.then(() => 'done' as const),
    new Promise<'blocked'>((r) => setTimeout(() => r('blocked'), 50)),
  ]);
}

describe('route loads', () => {
  it('the root layout does not wait for the profile check while the session is locked', async () => {
    const { load } = await import('./+layout');
    const event = { url: new URL('http://x.test/posts'), fetch } as never;
    expect(await settlesPromptly(Promise.resolve(load(event)))).toBe('done');
    expect(fetchUserProfile).toHaveBeenCalled();
  });

  it('the post page opens before its post has arrived', async () => {
    const { load } = await import('./posts/[postId]/+page');
    const out = load({ params: { postId: 'p1' } } as never);
    expect(await settlesPromptly(Promise.resolve(out))).toBe('done');
    const data = (await out) as unknown as { post: Promise<unknown>; seo: { path: string } };
    expect(data.post).toBeInstanceOf(Promise);
    expect(data.seo.path).toBe('/posts/p1');
  });
});
