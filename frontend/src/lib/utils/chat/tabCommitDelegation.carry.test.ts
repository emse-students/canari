// @vitest-environment happy-dom
/**
 * The requester id a tab carries across its promotion reload is adopted by the page THAT RELOAD
 * starts, and by no copy of it (second review of #4053).
 */
const KEY = 'canari_tab_commit_requester';

async function loadWith(navigationType: string | null) {
  vi.resetModules();
  vi.spyOn(performance, 'getEntriesByType').mockReturnValue(
    (navigationType === null ? [] : [{ type: navigationType }]) as never
  );
  return import('./tabCommitDelegation');
}

describe('the requester id carried across a promotion reload', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('is adopted by the page the reload starts, and removed at once', async () => {
    sessionStorage.setItem(KEY, 'tab-before');
    const mod = await loadWith('reload');
    expect(mod.carriedTabCommitRequester()).toBe('tab-before');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('is NOT adopted by a duplicated tab, whose first page is a navigation', async () => {
    sessionStorage.setItem(KEY, 'tab-before');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await loadWith('navigate');
    expect(mod.carriedTabCommitRequester()).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it('carries nothing when nothing was carried', async () => {
    const mod = await loadWith('reload');
    expect(mod.carriedTabCommitRequester()).toBeNull();
  });
});
