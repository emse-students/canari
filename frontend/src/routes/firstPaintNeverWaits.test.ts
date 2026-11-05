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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const hoisted = vi.hoisted(() => ({
  userId: null as string | null,
  refresh: undefined as undefined | (() => Promise<unknown>),
  goto: vi.fn(async (..._args: unknown[]) => {}),
  pathname: '/posts',
}));

vi.mock('$lib/stores/user', () => ({ currentUserId: () => hoisted.userId }));
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
import BootGate from '$lib/components/layout/BootGate.svelte';
import { bootSessionPhase, resetBootSessionForTest } from '$lib/stores/bootSession.svelte';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import { m } from '$lib/paraglide/messages';

const event = () => ({ url: new URL('http://x.test/posts'), fetch }) as never;
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
    const gate = mountGate();

    await load(event());
    flushSync();

    expect(bootSessionPhase()).toBe('resolving');
    expect(gate.textContent).toContain(m.boot_connecting());
    expect(hoisted.goto).not.toHaveBeenCalled();
  });

  it('states an unreachable network on a deadline, without a login redirect', async () => {
    hoisted.refresh = () =>
      Promise.reject(new RequestDeadlineError('read', 20_000, 'POST', '/api/auth/refresh', 0));
    const gate = mountGate();

    await load(event());
    await settle();

    expect(bootSessionPhase()).toBe('unreachable');
    expect(gate.textContent).toContain(m.boot_unreachable_title());
    expect(gate.textContent).toContain(m.boot_unreachable_retry());
    expect(hoisted.goto).not.toHaveBeenCalled();
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
    const gate = mountGate();
    await load(event());
    await settle();
    expect(bootSessionPhase()).toBe('unreachable');

    gate.querySelector('button')!.click();
    await settle();

    expect(attempts).toBe(2);
    expect(bootSessionPhase()).toBe('settled');
    expect(gate.querySelector('[data-testid="boot-gate"]')).toBeNull();
    expect(hoisted.goto).not.toHaveBeenCalled();
  });

  it('draws nothing for a route a visitor may read, whatever the question', async () => {
    hoisted.refresh = () => new Promise<never>(() => {});
    hoisted.pathname = '/login';
    const gate = mountGate();
    await load(event());
    flushSync();
    expect(gate.querySelector('[data-testid="boot-gate"]')).toBeNull();
  });
});
