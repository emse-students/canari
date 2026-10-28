// @vitest-environment happy-dom
/**
 * A PATH OF UNKNOWN ORIGIN IS MATCHED BEFORE IT IS NAVIGATED TO (SvelteKit 3, #2613).
 *
 * Kit 3's `goto` REJECTS a path no route matches, where Kit 2 navigated natively. `gotoAppPath`
 * asks the route table first: a page of this build goes through the router, anything else is loaded
 * as a document so the server answers it (a newer build's page, or the 404 page) - and is logged at
 * error by its shape. The route table here is the app's own (`src/test/mocks/app-paths.ts` reads
 * `src/routes`), so these are the answers the app gives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const goto = vi.hoisted(() => vi.fn(async (_href: string, _opts?: unknown) => {}));
vi.mock('$app/navigation', () => ({ goto }));

import { gotoAppPath } from './gotoAppPath';

afterEach(() => {
  goto.mockClear();
  vi.restoreAllMocks();
});

function stubDocumentLoads() {
  const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
  const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => {});
  return { assign, replace };
}

describe('gotoAppPath', () => {
  it('routes a page this build has, keeping its query and fragment', async () => {
    const { assign } = stubDocumentLoads();
    await gotoAppPath('/posts/p-1?comment=c-2#top', { replace: true });
    expect(goto).toHaveBeenCalledWith('/posts/p-1?comment=c-2#top', { replace: true });
    expect(assign).not.toHaveBeenCalled();
  });

  it('loads a path no route matches as a document, never handing it to the router', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { assign, replace } = stubDocumentLoads();
    await gotoAppPath('/a-page-removed-since/1234-5678?x=1');
    expect(goto).not.toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('/a-page-removed-since/1234-5678?x=1');
    expect(replace).not.toHaveBeenCalled();
    // Logged at ERROR, by its shape: the first segment only, never the id after it.
    expect(error).toHaveBeenCalledTimes(1);
    const line = String(error.mock.calls[0][0]);
    expect(line).toContain('matches no route');
    expect(line).not.toContain('1234-5678');
  });

  it('replaces the history entry for a document load when asked to', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { assign, replace } = stubDocumentLoads();
    await gotoAppPath('/nowhere', { replace: true });
    expect(replace).toHaveBeenCalledWith('/nowhere');
    expect(assign).not.toHaveBeenCalled();
  });
});
