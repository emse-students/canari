import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pkceChallenge } from '$lib/utils/pkce';

/**
 * THE MICONNECT SIGN-IN CARRIES PKCE. The authorize request sends an S256 challenge, the verifier
 * stays on the device, and the callback hands it to core-service with the code - so a code captured
 * on its way back (another app claiming the custom scheme) cannot be redeemed by anybody else.
 */

const invokeMock = vi.hoisted(() => vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>());

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => true,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  isTauri: () => false,
}));

vi.stubEnv('VITE_AUTHENTIK_URL', 'https://auth.example');
vi.stubEnv('VITE_AUTHENTIK_CLIENT_ID', 'client');

const { startOidcLogin, handleOidcCallback } = await import('$lib/stores/auth');

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
  const init = fetchMock.mock.calls[0]![1]!;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('PKCE on the MiConnect sign-in', () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    localStorage.clear();
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

  it('spends the verifier with the code: a second callback has none to send', async () => {
    await startOidcLogin('/chat');
    const state = openedAuthorizeUrl().searchParams.get('state')!;
    await callbackBody(state);

    localStorage.setItem('canari_oidc_state', state);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await callbackBody(state);
    expect(second.code_verifier).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no PKCE verifier'));
    warn.mockRestore();
  });
});
