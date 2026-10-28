// @vitest-environment happy-dom
import { openClaimedAppLink } from './appLinkNavigation';

const goto = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('$app/navigation', () => ({ goto }));

beforeEach(() => goto.mockClear());

describe('openClaimedAppLink', () => {
  it('opens a claimed Canari page in the app', async () => {
    expect(openClaimedAppLink('https://canari.emse.fr/posts/abc?x=1')).toBe(true);
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/posts/abc?x=1', {}));
  });

  it('keeps an invite link fragment, the admission proof the join page reads (section 25)', async () => {
    expect(openClaimedAppLink('https://canari.emse.fr/c/join/tok#AAAAF2Nhbg-_x')).toBe(true);
    await vi.waitFor(() => expect(goto).toHaveBeenCalledWith('/c/join/tok#AAAAF2Nhbg-_x', {}));
  });

  it('loads a Canari page this build does not have as a document, for the server to answer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
    // A link to a page added after this app was built (a newer web build may serve it).
    expect(openClaimedAppLink('https://canari.emse.fr/posts/abc/a-newer-tab')).toBe(true);
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/posts/abc/a-newer-tab'));
    expect(goto).not.toHaveBeenCalled();
    assign.mockRestore();
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
