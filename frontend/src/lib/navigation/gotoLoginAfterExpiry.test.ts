// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const goto = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => `/${p.replace(/^\//, '')}` }));

const { gotoLoginAfterExpiry } = await import('./gotoLoginAfterExpiry');

beforeEach(() => goto.mockClear());

/** Runs the redirect from `path` and returns the single target it navigated to. */
async function from(path: string): Promise<string> {
  history.replaceState(null, '', path);
  await gotoLoginAfterExpiry();
  expect(goto).toHaveBeenCalledTimes(1);
  expect(goto).toHaveBeenCalledWith(expect.any(String), { replace: true });
  return (goto.mock.calls[0] as unknown as [string])[0];
}

describe('gotoLoginAfterExpiry', () => {
  it('carries the page the user was on, query and hash included', async () => {
    const to = await from('/posts/p1?comment=c1#x');
    expect(to).toBe(`/login?returnTo=${encodeURIComponent('/posts/p1?comment=c1#x')}`);
  });

  it.each([
    '/',
    '/login',
    '/login?returnTo=%2Fposts',
    '/auth/callback',
    '/legal/privacy',
    '/f/abc',
  ])('goes to a bare /login from %s, never nesting a returnTo', async (path) => {
    expect(await from(path)).toBe('/login');
  });
});
