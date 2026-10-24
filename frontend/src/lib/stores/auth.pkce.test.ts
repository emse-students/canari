// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pkceChallenge } from '$lib/utils/pkce';

/**
 * THE MICONNECT SIGN-IN CARRIES PKCE WHEN THE SERVER CAN REDEEM IT. The authorize request sends an
 * S256 challenge, the verifier stays on the device, and the callback hands it to core-service with
 * the code - but only after `/api/version` said `oidcPkce`: an older core-service drops the verifier
 * and MiConnect would refuse the challenged code, so against it no challenge is sent at all.
 *
 * WHERE THE VERIFIER LIVES. On the web, `sessionStorage` (the redirect stays in one tab); in a native
 * app, the plugin store file, which survives the WebView's navigation.
 */

const invokeMock = vi.hoisted(() => vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>());
const env = vi.hoisted(() => ({ native: false, oidcPkce: true as boolean | undefined }));
const nativeStore = vi.hoisted(() => new Map<string, unknown>());

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));
// The authorize URL is opened through the in-app browser command, which is where it is read back.
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => true,
  isAndroidTauriRuntime: () => false,
}));
vi.mock('$lib/utils/tauriRuntime', () => ({ isTauriRuntime: () => env.native }));
vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => ({
    set: async (k: string, v: unknown) => void nativeStore.set(k, v),
    get: async (k: string) => nativeStore.get(k),
    delete: async (k: string) => nativeStore.delete(k),
    save: async () => {},
  }),
}));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  getAppVersionCheck: () => (env.oidcPkce === undefined ? null : { oidcPkce: env.oidcPkce }),
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  isTauri: () => false,
}));

vi.stubEnv('VITE_AUTHENTIK_URL', 'https://auth.example');
vi.stubEnv('VITE_AUTHENTIK_CLIENT_ID', 'client');

const { startOidcLogin, handleOidcCallback, OidcSignInError } = await import('$lib/stores/auth');
type OidcSignInError = InstanceType<typeof OidcSignInError>;

const VERIFIER_KEY = 'canari_oidc_verifier';
const CHALLENGED_KEY = 'canari_oidc_challenged';

/** The authorize URL the last sign-in opened in the in-app browser. */
function openedAuthorizeUrl(): URL {
  const [, args] = invokeMock.mock.calls.at(-1)!;
  return new URL((args as { url: string }).url);
}

/** Runs the callback with core-service answering, and returns the body it was POSTed. */
async function callbackBody(state: string): Promise<Record<string, unknown>> {
  const fetchMock = vi.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ access_token: 'h.e30.s', user: { id: 'user-1' } }), {
        status: 200,
      })
  );
  vi.stubGlobal('fetch', fetchMock);
  await handleOidcCallback('code', state);
  const call = fetchMock.mock.calls.find(([url]) => String(url).includes('/oidc/callback'))!;
  return JSON.parse(String(call[1]!.body)) as Record<string, unknown>;
}

describe('PKCE on the MiConnect sign-in', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
    sessionStorage.clear();
    nativeStore.clear();
    env.native = false;
    env.oidcPkce = true;
  });

  it('sends an S256 challenge, and redeems the code with the verifier it hashes', async () => {
    await startOidcLogin('/chat');
    const url = openedAuthorizeUrl();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const body = await callbackBody(url.searchParams.get('state')!);
    expect(typeof body.code_verifier).toBe('string');
    expect(await pkceChallenge(body.code_verifier as string)).toBe(challenge);
  });

  it('keeps the verifier in sessionStorage on the web, never in localStorage', async () => {
    await startOidcLogin('/chat');
    expect(sessionStorage.getItem(VERIFIER_KEY)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(localStorage.getItem(VERIFIER_KEY)).toBeNull();
  });

  it('keeps the verifier in the native store in an app, and spends it there', async () => {
    env.native = true;
    await startOidcLogin('/chat');
    const url = openedAuthorizeUrl();
    const held = nativeStore.get(VERIFIER_KEY);
    expect(held).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
    expect(localStorage.getItem(VERIFIER_KEY)).toBeNull();

    const body = await callbackBody(url.searchParams.get('state')!);
    expect(body.code_verifier).toBe(held);
    expect(await pkceChallenge(held as string)).toBe(url.searchParams.get('code_challenge'));
    expect(nativeStore.has(VERIFIER_KEY)).toBe(false);
  });

  it.each([
    ['says it has no oidcPkce', false],
    ['has not answered', undefined],
  ])('sends no challenge and no verifier when the server %s', async (_n, offered) => {
    env.oidcPkce = offered;
    sessionStorage.setItem(VERIFIER_KEY, 'left-by-a-sign-in-that-never-came-back');
    await startOidcLogin('/chat');
    const url = openedAuthorizeUrl();
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);

    const body = await callbackBody(url.searchParams.get('state')!);
    expect(body).not.toHaveProperty('code_verifier');
  });

  it('marks a challenged sign-in beside its state, and spends the mark with the code', async () => {
    await startOidcLogin('/chat');
    expect(localStorage.getItem(CHALLENGED_KEY)).toBe('S256');
    await callbackBody(openedAuthorizeUrl().searchParams.get('state')!);
    expect(localStorage.getItem(CHALLENGED_KEY)).toBeNull();
    expect(sessionStorage.getItem(VERIFIER_KEY)).toBeNull();
  });

  it('does not post a challenged code that came back to a context without its verifier', async () => {
    await startOidcLogin('/chat');
    const state = openedAuthorizeUrl().searchParams.get('state')!;
    // A new tab or a PWA handing off: localStorage (state + mark) is shared, sessionStorage is not.
    sessionStorage.clear();
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const err = await handleOidcCallback('code', state).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OidcSignInError);
    expect((err as OidcSignInError).failure).toBe('verifier-lost');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/oidc/callback'))).toBe(
      false
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('without the PKCE verifier'));
    expect(localStorage.getItem(CHALLENGED_KEY)).toBeNull();
    warn.mockRestore();
  });

  it('still posts an unchallenged code from any context, and clears a stale mark', async () => {
    env.oidcPkce = false;
    localStorage.setItem(CHALLENGED_KEY, 'S256');
    await startOidcLogin('/chat');
    expect(localStorage.getItem(CHALLENGED_KEY)).toBeNull();
    const state = openedAuthorizeUrl().searchParams.get('state')!;
    sessionStorage.clear();
    const body = await callbackBody(state);
    expect(body).not.toHaveProperty('code_verifier');
  });

  it.each(['OIDC_PKCE_REFUSED', 'OIDC_CODE_REFUSED'])(
    'turns the typed refusal %s into a localized sign-in error, not the server text',
    async (code) => {
      await startOidcLogin('/chat');
      const state = openedAuthorizeUrl().searchParams.get('state')!;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ statusCode: 401, code, message: 'MiConnect refused the code' }),
              { status: 401 }
            )
        )
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const err = await handleOidcCallback('code', state).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OidcSignInError);
      expect((err as OidcSignInError).failure).toBe('code-refused');
      expect((err as Error).message).not.toContain('MiConnect refused the code');
      warn.mockRestore();
    }
  );

  it('spends the verifier with the code: a second callback has none to send', async () => {
    await startOidcLogin('/chat');
    const state = openedAuthorizeUrl().searchParams.get('state')!;
    await callbackBody(state);

    localStorage.setItem('canari_oidc_state', state);
    const second = await callbackBody(state);
    expect(second).not.toHaveProperty('code_verifier');
  });
});
