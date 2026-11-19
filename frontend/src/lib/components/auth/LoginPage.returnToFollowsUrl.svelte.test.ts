// @vitest-environment happy-dom
/**
 * A LOGIN PAGE ALREADY MOUNTED FOLLOWS A NEW `?returnTo=` (Mi 9T, 2026-11-15). SvelteKit reuses the
 * component when a second redirect reaches `/login` with another target - a push tapped while the
 * page was up - and the target read once in `onMount` signed in to the PREVIOUS page. The sign-in
 * must carry whatever the url says when the button is pressed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount, tick } from 'svelte';
import { routeUrl } from '../../../test/stubs/routeUrlStub.svelte';

const startOidcLogin = vi.hoisted(() => vi.fn(async () => ({ kind: 'started' })));

vi.mock('$app/state', () => ({
  page: {
    get url() {
      return routeUrl;
    },
  },
}));
vi.mock('$lib/stores/auth', () => ({
  startOidcLogin: (...a: unknown[]) => (startOidcLogin as (...a: unknown[]) => unknown)(...a),
  hasStoredSession: async () => false,
  getToken: async () => 'token',
  PASSWORD_LOGIN_FLOW_SLUG: 'password-login',
}));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  getAppVersionCheck: () => null,
  isBelowMinClientVersion: () => false,
  refreshAppVersionCheck: async () => {},
}));
vi.mock('$lib/services/biometric', () => ({
  BiometricService: { isAvailable: async () => false },
}));
vi.mock('$lib/services/restoreCredential', () => ({
  attemptRestore: async () => ({ outcome: 'not-applicable' }),
}));
vi.mock('$lib/utils/openExternal', () => ({ isTauriRuntime: () => true }));
vi.mock('$lib/utils/appForeground', () => ({ onAppForegroundChange: () => () => {} }));
vi.mock('$lib/navigation/gotoAppPath', () => ({ gotoAppPath: vi.fn(async () => {}) }));
vi.mock('svelte/transition', () => ({ fade: () => ({}), slide: () => ({}) }));

const { default: LoginPage } = await import('./LoginPage.svelte');

let app: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (app) void unmount(app);
  app = null;
  document.body.innerHTML = '';
  startOidcLogin.mockClear();
});

function loginAt(returnTo: string): string {
  return `https://canari.test/login?returnTo=${encodeURIComponent(returnTo)}`;
}

describe('LoginPage returnTo', () => {
  it('signs in to the target of the CURRENT url, not the one it mounted with', async () => {
    routeUrl.href = loginAt('/posts/a?comment=1');
    const target = document.createElement('div');
    document.body.appendChild(target);
    app = mount(LoginPage, { target });
    for (let i = 0; i < 10; i++) await tick();

    // The second redirect: same route, new query.
    routeUrl.href = loginAt('/posts/b?comment=2');
    flushSync();

    const button = document.querySelector<HTMLButtonElement>('button[type="submit"], button');
    expect(button).not.toBeNull();
    button!.click();
    for (let i = 0; i < 10; i++) await tick();

    expect(startOidcLogin).toHaveBeenCalled();
    expect((startOidcLogin.mock.calls[0] as unknown[])[0]).toBe('/posts/b?comment=2');
  });
});
