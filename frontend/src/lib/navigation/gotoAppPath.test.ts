// @vitest-environment happy-dom
/**
 * A PATH OF UNKNOWN ORIGIN IS MATCHED BEFORE IT IS NAVIGATED TO (SvelteKit 3, #2613).
 *
 * Kit 3's `goto` REJECTS a path no route matches, where Kit 2 navigated natively. `gotoAppPath`
 * asks the route table first: a page of this build goes through the router, anything else is loaded
 * as a document (the server on the web, the embedded build on a phone) - and is logged at error by
 * its shape. A target is validated against the page's origin before a full-page load. The route table here is the app's own (`src/test/mocks/app-paths.ts` reads
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
    expect(assign).toHaveBeenCalledWith(
      new URL('/a-page-removed-since/1234-5678?x=1', window.location.href).href
    );
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
    expect(replace).toHaveBeenCalledWith(new URL('/nowhere', window.location.href).href);
    expect(assign).not.toHaveBeenCalled();
  });

  it('loads nothing for a target that resolves to another origin', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { assign, replace } = stubDocumentLoads();
    const TAB = String.fromCharCode(9);
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const BS = String.fromCharCode(92);
    for (const target of [
      `/${TAB}/x.example/p`,
      `/${LF}/x.example`,
      `/${CR}/x.example`,
      `/${TAB}${BS}x.example`,
    ]) {
      await gotoAppPath(target);
      await gotoAppPath(target, { replace: true });
    }
    expect(assign).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(goto).not.toHaveBeenCalled();
    // Logged by length only: no part of the value reaches the log.
    for (const [line] of error.mock.calls) {
      expect(String(line)).toContain('another origin');
      expect(String(line)).not.toContain('x.example');
    }
  });
});
