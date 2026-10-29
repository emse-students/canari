// @vitest-environment happy-dom
/**
 * A PAGE THAT CRASHES IS CAUGHT BY SVELTEKIT'S BOUNDARY, SO THE REPORT AND THE SCREEN ARE THE APP'S
 * ONLY SAY IN IT (#2613, SvelteKit 3).
 *
 * Kit 3's root (`kit/src/runtime/components/root.svelte`, mounted here for real) wraps every route
 * node in a `<svelte:boundary>` armed with the root `+error.svelte` (the REAL one here), inside the
 * layout's `children` - so the boundary the root layout used to hold never saw a crash. Kit mounts
 * that root with `transformError`, which runs the error through the client `handleError` hook and
 * writes the result to `page` before the error page draws (`client.js`, `initialize` and
 * `handle_error`); `kitTransformError` below is that seam, reduced to what the hook and the page read.
 *
 * What this cannot see: Kit's own navigation, which is what resets a failed boundary after Retry
 * (`resetters`, drained once the next navigation settles) - `goto` is a mock here. That half was
 * read on the static build: a page that threw once came back on Retry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import Root from '../../node_modules/@sveltejs/kit/src/runtime/components/root.svelte';
import ErrorPage from './+error.svelte';
import KitLayoutStub from '../test/stubs/KitLayoutStub.svelte';
import ThrowingPageStub from '../test/stubs/ThrowingPageStub.svelte';
import { handleClientError } from '$lib/navigation/handleClientError';
import { m } from '$lib/paraglide/messages';
import { flushMacrotask } from '../test/flush';

const state = vi.hoisted(() => ({
  page: {
    status: 200,
    error: null as { status: number; message: string } | null,
    url: new URL('https://canari.test/posts/p-1?tab=comments'),
    route: { id: '/posts/[postId]' as string | null },
    params: { postId: 'p-1' },
    data: {},
    form: null,
    state: {},
  },
}));
vi.mock('$app/state', () => state);

const nav = vi.hoisted(() => ({
  goto: vi.fn(async (_href: string, _opts?: unknown) => {}),
  afterNavigate: vi.fn(),
}));
vi.mock('$app/navigation', () => nav);

/** The route table, reduced to the two routes these tests open. */
const ROUTES: Record<string, string> = {
  '/posts/p-1': '/posts/[postId]',
  '/calendar': '/calendar',
};
vi.mock('$app/paths', () => ({
  resolve: (path: string) => (path.startsWith('/') ? path : `/${path}`),
  match: async (url: URL) =>
    ROUTES[url.pathname] ? { id: ROUTES[url.pathname], params: {} } : null,
}));

/**
 * Kit's `transformError` + `handle_error` for a throw nobody named (`kind: 'unknown'`), with the
 * event Kit 3.1.0 really builds before the first navigation: the right `url`, and `route.id` NULL.
 */
async function kitTransformError(error: unknown) {
  const { page } = state;
  const event = { params: {}, route: { id: null }, url: page.url };
  const hooked = await handleClientError({ kind: 'unknown', error, event } as never);
  const appError = { status: 500, message: 'Internal Error', ...hooked };
  page.status = appError.status;
  page.error = appError;
  return appError;
}

const mounted: (() => void)[] = [];
afterEach(() => {
  mounted.splice(0).forEach((f) => f());
  document.body.innerHTML = '';
  nav.goto.mockClear();
  state.page.status = 200;
  state.page.error = null;
  vi.restoreAllMocks();
});

async function crashAPage(): Promise<HTMLElement> {
  // Kit's `RenderNode` and `Props` are `$state` classes in a `.svelte.js` module this suite does not
  // compile from `node_modules`; Root reads only these fields, once, so plain objects stand in.
  const tree = {
    component: KitLayoutStub,
    error: undefined,
    data: {},
    child: { component: ThrowingPageStub, error: ErrorPage, data: {}, child: undefined },
  };
  const resetters = new Set<() => void>();
  const props = {
    page: state.page,
    components: [],
    tree,
    form: undefined,
    error: undefined,
    onerror: (_e: unknown, reset: () => void) => resetters.add(reset),
  };
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(Root, { target, props, transformError: kitTransformError } as never);
  mounted.push(() => void unmount(app));
  for (let i = 0; i < 4; i++) {
    await flushMacrotask();
    flushSync();
  }
  return target;
}

describe('a page that crashes under SvelteKit 3', () => {
  it('is reported ONCE, at error, naming the route id and not the URL', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await crashAPage();
    const lines = error.mock.calls.filter((c) => String(c[0]).includes('page crash'));
    expect(lines).toHaveLength(1);
    expect(lines[0][0]).toBe('[App] page crash on /posts/[postId]:');
    expect(String(lines[0][1])).toContain('page effect threw');
    expect(lines[0].join(' ')).not.toContain('p-1');
  });

  it('draws the error page inside the layout, with the Retry the layout used to offer', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = await crashAPage();
    expect(target.querySelector('[data-testid="layout"]')).not.toBeNull();
    expect(target.querySelector('[data-testid="page"]')).toBeNull();
    expect(target.textContent).toContain(m.layout_error_boundary_message());
    const buttons = [...target.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([
      m.common_retry_button(),
      m.error_back_home(),
    ]);
  });

  it('retries by navigating to the SAME address, loads re-run', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = await crashAPage();
    const retry = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.common_retry_button()
    )!;
    retry.click();
    expect(nav.goto).toHaveBeenCalledWith('/posts/p-1?tab=comments', {
      replace: true,
      refreshAll: true,
    });
  });

  it('never sends a crashed reader to /login - the way out is the home page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = await crashAPage();
    const home = [...target.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === m.error_back_home()
    )!;
    home.click();
    expect(nav.goto).toHaveBeenCalledWith('/posts', { replace: true });
    expect(nav.goto.mock.calls.some((c) => String(c[0]).includes('login'))).toBe(false);
  });
});

describe('the error page for an answer that is not a crash', () => {
  it('a 404 says so, offers no Retry, and its way out is the home page', async () => {
    state.page.status = 404;
    state.page.error = { status: 404, message: 'Not Found' };
    const target = document.createElement('div');
    document.body.appendChild(target);
    const app = mount(ErrorPage, { target });
    mounted.push(() => void unmount(app));
    flushSync();
    expect(target.textContent).toContain('404');
    expect(target.textContent).toContain('Not Found');
    const buttons = [...target.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual([m.error_back_home()]);
  });
});

describe('handleClientError, the one report', () => {
  const event = (pathname: string, id: string | null) => ({
    route: { id },
    params: {},
    url: new URL(`https://canari.test${pathname}`),
  });

  it('a 4xx is a warning, and an address no route matches is named `?`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleClientError({
      kind: 'framework',
      error: { status: 404, message: 'Not Found' },
      event: event('/nowhere', null),
    } as never);
    expect(error).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toBe('[App] navigation error 404 on ?:');
  });

  it('a 5xx app error is a page crash, its route matched from the URL Kit hands over', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await handleClientError({
      kind: 'app',
      error: { status: 503, message: 'down' },
      event: event('/calendar', null),
    } as never);
    expect(error.mock.calls[0][0]).toBe('[App] page crash on /calendar:');
  });
});
