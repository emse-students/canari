// @vitest-environment happy-dom
/**
 * NAVIGATION NEVER WAITS ON DATA (WP-NAV-1, 2026-10-10). A tap on a weak link must show the next page
 * at once. Pinned for the two loads that used to hold it: the root layout (a profile round trip
 * before EVERY page while the session was not unlocked) and the post page (its own GET). Each
 * `load` must RESOLVE while its network call is still pending.
 */
import { describe, expect, it, vi } from 'vitest';
// Imported statically: the layout's module graph is large, and an `await import()` inside the test
// is cold under load and spends the 5 s test timeout on module evaluation, not on the behaviour.
import { load as layoutLoad } from './+layout';
import { load as postLoad } from './posts/[postId]/+page';

// Hoisted: the static imports above evaluate the modules, so the mock factories read these first.
const { pending, fetchUserProfile, getPost } = vi.hoisted(() => {
  const pending = () => new Promise<never>(() => {});
  return { pending, fetchUserProfile: vi.fn(pending), getPost: vi.fn(pending) };
});
vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  fetchUserProfile: () => fetchUserProfile(),
  UserProfileFetchError: class extends Error {},
}));
vi.mock('$lib/stores/auth', () => ({ refresh: pending }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => (p.startsWith('/') ? p : `/${p}`) }));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: false, isLoginInProgress: false },
}));
vi.mock('$lib/posts/api', () => ({ getPost: () => getPost() }));
vi.mock('$lib/posts/feedAudience', () => ({ redirectIfNotFeedAudience: async () => false }));

/** Resolves to 'done' once the promise settles; one that never does fails on the test timeout. */
async function settlesPromptly(p: Promise<unknown>): Promise<'done'> {
  return p.then(() => 'done' as const);
}

describe('route loads', () => {
  it('the root layout does not wait for the profile check while the session is locked', async () => {
    const event = { url: new URL('http://x.test/posts'), fetch } as never;
    expect(await settlesPromptly(Promise.resolve(layoutLoad(event)))).toBe('done');
    expect(fetchUserProfile).toHaveBeenCalled();
  });

  it('the post page opens before its post has arrived', async () => {
    const out = postLoad({ params: { postId: 'p1' } } as never);
    expect(await settlesPromptly(Promise.resolve(out))).toBe('done');
    const data = (await out) as unknown as { post: Promise<unknown>; seo: { path: string } };
    expect(data.post).toBeInstanceOf(Promise);
    expect(data.seo.path).toBe('/posts/p1');
  });
});
