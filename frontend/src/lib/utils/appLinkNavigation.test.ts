import { openClaimedAppLink } from './appLinkNavigation';

const goto = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$app/navigation', () => ({ goto }));

beforeEach(() => goto.mockClear());

describe('openClaimedAppLink', () => {
  it('opens a claimed Canari page in the app', async () => {
    expect(openClaimedAppLink('https://canari.emse.fr/posts/abc?x=1')).toBe(true);
    await Promise.resolve();
    expect(goto).toHaveBeenCalledWith('/posts/abc?x=1');
  });

  it('refuses what an App Link could never have delivered', () => {
    // `fr.emse.canari://open?url=` is a URL anyone can write: it must not reach more than a link.
    expect(openClaimedAppLink('https://canari.emse.fr/auth/callback?code=1&state=2')).toBe(false);
    expect(openClaimedAppLink('https://canari.emse.fr/admin/users')).toBe(false);
    expect(openClaimedAppLink('https://example.com/posts/abc')).toBe(false);
    expect(openClaimedAppLink('/posts/abc')).toBe(false);
    expect(openClaimedAppLink('')).toBe(false);
    expect(goto).not.toHaveBeenCalled();
  });
});
