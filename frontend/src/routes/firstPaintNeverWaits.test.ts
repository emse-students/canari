// @vitest-environment happy-dom
/**
 * FIRST PAINT NEVER WAITS ON THE NETWORK (2026-11-05). Two users abroad saw the app stuck on its
 * splash from launch: the root `load` awaited the silent refresh (20 s deadline, re-sent once), and
 * an SPA draws nothing until the root load resolves. Pinned here, through the REAL `load`, the
 * `bootSession` store and the `BootGate` screen:
 * - the load resolves while the refresh has not, and the screen already says it is connecting;
 * - a transport failure (the deadline) is STATED as "cannot reach", never a login redirect;
 * - an answer (401) still routes to login;
 * - a retry after the failure asks again and, answered, hands the user to the app.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const hoisted = vi.hoisted(() => ({
  userId: null as string | null,
  refresh: undefined as undefined | (() => Promise<unknown>),
  goto: vi.fn(async (..._args: unknown[]) => {}),
  pathname: '/posts',
}));

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => hoisted.userId,
  isGlobalAdmin: () => false,
}));
// The token-bound calls of the page loads: each stands for a request that joins the hanging refresh.
vi.mock('$lib/posts/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/posts/api')>()),
  listPosts: () => new Promise<never>(() => {}),
  getPost: () => new Promise<never>(() => {}),
  fetchFeedAudience: () => new Promise<never>(() => {}),
}));
vi.mock('$lib/stores/auth', () => ({ refresh: () => hoisted.refresh!() }));
vi.mock('$lib/utils/sessionProfileCheck', () => ({ checkSessionUserInBackground: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: (...a: unknown[]) => hoisted.goto(...a) }));
vi.mock('$app/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return new URL(`http://x.test${hoisted.pathname}`);
    },
  },
}));
vi.mock('$lib/stores/globalChatSingleton.svelte', () => ({
  globalSession: { isLoggedIn: false, isLoginInProgress: false },
}));

import { load } from './+layout';
import { load as loadPosts } from './posts/+page';
import { load as loadPost } from './posts/[postId]/+page';
import BootGate from '$lib/components/layout/BootGate.svelte';
import {
  bootSessionPhase,
  bootUnreachableCause,
  resetBootSessionForTest,
  startBootSession,
} from '$lib/stores/bootSession.svelte';
import { noteSessionAnswered } from '$lib/stores/sessionAnswer.svelte';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import {
  RefreshFailedError,
  TransientAnswerError,
  TransportFailureError,
} from '$lib/utils/transportFailure';
import { NotFromApiError } from '$lib/utils/apiJson';
import { m } from '$lib/paraglide/messages';

/** The title the unreachable screen shows for each cause. */
const COPY = {
  network: m.boot_unreachable_title,
  server: m.boot_server_error_title,
  maintenance: m.platform_gate_maintenance_title,
} as const;
import { adoptTransitionAnimations } from '../test/adoptTransitionAnimations';

// The gate is a ModalOverlay: its intro/outro animations are adopted so teardown rejects nothing.
afterAll(adoptTransitionAnimations());

const event = (path = '/posts') => ({ url: new URL(`http://x.test${path}`), fetch }) as never;
const mounted: (() => void)[] = [];

function mountGate(): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const app = mount(BootGate, { target });
  mounted.push(() => void unmount(app));
  flushSync();
  return target;
}

/** Lets the boot's promise chain run to its next resting point. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  flushSync();
};

beforeEach(() => {
  resetBootSessionForTest();
  hoisted.userId = null;
  hoisted.pathname = '/posts';
  hoisted.goto.mockClear();
});
afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
});

describe('first paint never waits on the network', () => {
  it('resolves the load and shows the boot state while the refresh has not answered', async () => {
    hoisted.refresh = () => new Promise<never>(() => {});
    mountGate();

    await load(event());
    flushSync();

    expect(bootSessionPhase()).toBe('resolving');
    expect(document.body.textContent).toContain(m.boot_connecting());
    expect(hoisted.goto).not.toHaveBeenCalled();
  });

  it('states an unreachable network on a deadline, without a login redirect', async () => {
    hoisted.refresh = () =>
      Promise.reject(new RequestDeadlineError('read', 20_000, 'POST', '/api/auth/refresh', 0));
    mountGate();

    await load(event());
    await settle();

    expect(bootSessionPhase()).toBe('unreachable');
    expect(document.body.textContent).toContain(m.boot_unreachable_title());
    expect(document.body.textContent).toContain(m.boot_unreachable_retry());
    expect(hoisted.goto).not.toHaveBeenCalled();
  });

  it.each([
    ['a 5xx', new TransientAnswerError(503), 'server'],
    ['a 429', new TransientAnswerError(429), 'server'],
    ['the 503 MAINTENANCE', new TransientAnswerError(503, 'MAINTENANCE'), 'maintenance'],
    ['an edge HTML 403', new TransientAnswerError(403), 'network'],
    ['a network error', new TransportFailureError(new TypeError('Failed to fetch')), 'network'],
    [
      'a portal 200 text/html',
      new NotFromApiError('POST /api/auth/refresh', 200, 'text/html'),
      'network',
    ],
  ] as const)(
    'keeps the session question open on %s, without a login redirect, and names its cause',
    async (_name, failure, cause) => {
      hoisted.refresh = () => Promise.reject(failure);
      mountGate();

      await load(event());
      await settle();

      expect(bootSessionPhase()).toBe('unreachable');
      expect(bootUnreachableCause()).toBe(cause);
      expect(document.body.textContent).toContain(COPY[cause]());
      expect(hoisted.goto).not.toHaveBeenCalled();
    }
  );

  it('an app 404 (a verdict on the request, not on the network) still routes to login', async () => {
    hoisted.refresh = () => Promise.reject(new RefreshFailedError(404));
    mountGate();

    await load(event());
    await settle();

    expect(hoisted.goto).toHaveBeenCalledTimes(1);
    expect(bootSessionPhase()).toBe('settled');
  });

  describe('through the REAL refresh', () => {
    const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();
    beforeEach(async () => {
      fetchMock.mockReset();
      vi.stubGlobal('fetch', fetchMock);
      const real = await vi.importActual<typeof import('$lib/stores/auth')>('$lib/stores/auth');
      hoisted.refresh = () => real.refresh();
    });
    afterEach(() => vi.unstubAllGlobals());

    it.each([
      [
        'a 503 from the server',
        () => Response.json({ statusCode: 503, message: 'Service Unavailable' }, { status: 503 }),
        'server',
      ],
      [
        'a 503 MAINTENANCE',
        () => Response.json({ code: 'MAINTENANCE', message: 'Back soon' }, { status: 503 }),
        'maintenance',
      ],
      [
        "an edge's HTML 403 (a WAF ban page)",
        () =>
          new Response('<html>Access denied</html>', {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
        'network',
      ],
      [
        'a 200 whose body is lost on the way',
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.error(new TypeError('network error'));
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          ),
        'network',
      ],
      [
        "a captive portal's 200 text/html",
        () =>
          new Response('<html>Hotel Wi-Fi</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        'network',
      ],
    ] as const)('goes from %s to unreachable, never to login', async (_name, answer, cause) => {
      fetchMock.mockImplementation(async () => answer());
      mountGate();

      await load(event());
      await vi.waitFor(() => expect(bootSessionPhase()).toBe('unreachable'));
      flushSync();

      expect(fetchMock).toHaveBeenCalled();
      expect(bootUnreachableCause()).toBe(cause);
      expect(document.body.textContent).toContain(COPY[cause]());
      expect(hoisted.goto).not.toHaveBeenCalled();
    });

    it("shows the operator's maintenance text, as the platform gate does", async () => {
      fetchMock.mockImplementation(async () =>
        Response.json(
          { code: 'MAINTENANCE', message: 'Back at noon', maintenanceMessage: 'Back at noon' },
          { status: 503 }
        )
      );
      mountGate();

      await load(event());
      await vi.waitFor(() => expect(bootSessionPhase()).toBe('unreachable'));
      flushSync();

      expect(bootUnreachableCause()).toBe('maintenance');
      expect(document.body.textContent).toContain('Back at noon');
      expect(document.body.textContent).not.toContain(m.platform_gate_maintenance_default_msg());
    });

    it('words the default itself when the operator set no text (the body carries an English one)', async () => {
      fetchMock.mockImplementation(async () =>
        Response.json(
          {
            code: 'MAINTENANCE',
            message: 'Canari is under maintenance.',
            maintenanceMessage: null,
          },
          { status: 503 }
        )
      );
      mountGate();

      await load(event());
      await vi.waitFor(() => expect(bootSessionPhase()).toBe('unreachable'));
      flushSync();

      expect(document.body.textContent).toContain(m.platform_gate_maintenance_default_msg());
      expect(document.body.textContent).not.toContain('Canari is under maintenance.');
    });
  });

  it('believes MAINTENANCE only on a 503', async () => {
    hoisted.refresh = () => Promise.reject(new TransientAnswerError(502, 'MAINTENANCE'));
    mountGate();

    await load(event());
    await settle();

    expect(bootUnreachableCause()).toBe('server');
  });

  it('still routes an app 403 (a refusal the app itself answered) to the login screen', async () => {
    const refused = Object.assign(new Error('Forbidden'), { name: 'SessionExpiredError' });
    hoisted.refresh = () => Promise.reject(refused);
    mountGate();

    await load(event());
    await settle();

    expect(hoisted.goto).toHaveBeenCalledTimes(1);
    expect(bootSessionPhase()).toBe('settled');
  });

  it('still routes a 401 to the login screen', async () => {
    const expired = Object.assign(new Error('Session expired'), { name: 'SessionExpiredError' });
    hoisted.refresh = () => Promise.reject(expired);
    mountGate();

    await load(event());
    await settle();

    expect(hoisted.goto).toHaveBeenCalledTimes(1);
    expect(String(hoisted.goto.mock.calls[0][0])).toContain('login?returnTo=%2Fposts');
    expect(bootSessionPhase()).toBe('settled');
  });

  it('retries from the unreachable screen and lands in the app once answered', async () => {
    let attempts = 0;
    hoisted.refresh = () => {
      attempts++;
      if (attempts === 1) {
        return Promise.reject(
          new RequestDeadlineError('read', 20_000, 'POST', '/api/auth/refresh', 0)
        );
      }
      hoisted.userId = 'user-1';
      return Promise.resolve('token');
    };
    mountGate();
    await load(event());
    await settle();
    expect(bootSessionPhase()).toBe('unreachable');

    document.body.querySelector<HTMLButtonElement>('[data-testid="boot-gate"] button')!.click();
    await settle();

    expect(attempts).toBe(2);
    expect(bootSessionPhase()).toBe('settled');
    expect(document.body.querySelector('[data-testid="boot-gate"]')).toBeNull();
    expect(hoisted.goto).not.toHaveBeenCalled();
  });

  it('draws nothing for a route a visitor may read, whatever the question', async () => {
    hoisted.refresh = () => new Promise<never>(() => {});
    hoisted.pathname = '/login';
    mountGate();
    await load(event());
    flushSync();
    expect(document.body.querySelector('[data-testid="boot-gate"]')).toBeNull();
  });

  it('a first visit to /posts, a post link and the root load ALL resolve while the refresh hangs', async () => {
    hoisted.refresh = () => new Promise<never>(() => {});
    // Every load of a navigation must resolve before SvelteKit renders anything: one that awaits
    // the audience verdict (token-bound, so joined to the hanging refresh) holds the splash.
    // No timer: a load that settles does so within a few microtask turns, one held on the hanging
    // refresh never does, so a flush and a flag tell them apart.
    let resolved = false;
    void Promise.all([
      load(event('/posts')),
      loadPosts({ url: new URL('http://x.test/posts') } as never),
      loadPost({ params: { postId: 'p1' } } as never),
    ]).then(() => (resolved = true));
    await settle();
    expect(resolved).toBe(true);
  });

  it('a link opened during the boot sets where login returns to', async () => {
    const expired = Object.assign(new Error('Session expired'), { name: 'SessionExpiredError' });
    let rejectRefresh!: (e: unknown) => void;
    hoisted.refresh = () => new Promise<never>((_, rej) => (rejectRefresh = rej));
    await load(event('/'));
    await load(event('/posts/abc'));
    rejectRefresh(expired);
    await settle();
    expect(String(hoisted.goto.mock.calls[0][0])).toBe('login?returnTo=%2Fposts%2Fabc');
  });

  it('a session known by another road ends the unreachable screen', async () => {
    hoisted.refresh = () =>
      Promise.reject(new RequestDeadlineError('read', 20_000, 'POST', '/api/auth/refresh', 0));
    mountGate();
    await load(event());
    await settle();
    expect(bootSessionPhase()).toBe('unreachable');
    noteSessionAnswered('user-1');
    await settle();
    expect(bootSessionPhase()).toBe('settled');
    expect(document.body.querySelector('[data-testid="boot-gate"]')).toBeNull();
    noteSessionAnswered(null);
  });

  it('an exception in the question never leaves the phase resolving', async () => {
    // Called directly: the throw must happen INSIDE the question, after `startBootSession`.
    let reads = 0;
    startBootSession({
      refresh: () => Promise.reject(new Error('refused')),
      currentUserId: () => {
        if (++reads > 1) throw new Error('store unreadable');
        return null;
      },
      goToLogin: () => {},
      onSessionKnown: () => {},
    });
    expect(bootSessionPhase()).toBe('resolving');
    await settle();
    expect(bootSessionPhase()).toBe('settled');
  });
});
