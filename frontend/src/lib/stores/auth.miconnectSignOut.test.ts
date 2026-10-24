// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SIGNING OUT OF CANARI ENDS THE MICONNECT SESSION (user decision, 2026-10-14).
 *
 * Before this, a sign-out revoked Canari's session and left MiConnect's cookie alive, so the next
 * "Se connecter" came straight back as the account that had just left - on the Mi 9T the user could
 * not reach their own account at all. These tests pin the three halves the client owns: the
 * id_token is KEPT at sign-in (Authentik's end-session refuses a return address without it), the
 * sign-out builds the end-session request from it, and every sign-out a person CHOSE goes through
 * that, while a dead session does not.
 */

const mobile = vi.hoisted(() => ({ value: false }));
const invokeMock = vi.hoisted(() => vi.fn<(cmd: string, args?: unknown) => Promise<unknown>>());
const gotoMock = vi.hoisted(() => vi.fn<(href: string, opts?: unknown) => Promise<void>>());

vi.mock('$lib/stores/user', () => ({
  currentUserId: () => 'user-1',
  saveUserLocally: vi.fn(),
  clearUserLocally: vi.fn(),
}));
vi.mock('$lib/utils/appVersion', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/utils/appVersion')>()),
  isMobileTauriRuntime: () => mobile.value,
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: unknown) => invokeMock(cmd, args),
  isTauri: () => false,
}));
vi.mock('$app/navigation', () => ({
  goto: (href: string, opts?: unknown) => gotoMock(href, opts),
}));

vi.stubEnv('VITE_AUTHENTIK_URL', 'https://auth.example');
vi.stubEnv('VITE_AUTHENTIK_CLIENT_ID', 'client');

const { planMiconnectSignOut, handleOidcCallback, leaveSignedOut } =
  await import('$lib/stores/auth');
const { connectivity } = await import('$lib/stores/connectivity.svelte');

const ISSUER = 'https://auth.example/application/o/canari/';

/** An unsigned id_token carrying `iss` - the client never verifies it, Authentik does. */
function idToken(iss = ISSUER): string {
  const claims = btoa(JSON.stringify({ iss, sub: 'user-1', aud: 'client' }));
  return `h.${claims.replace(/=+$/, '')}.s`;
}

const base = {
  idToken: idToken(),
  authentikBase: 'https://auth.example',
  mobile: false,
  offline: false,
  webLoginUrl: 'https://canari.example/login',
};

describe('the end-session request a sign-out makes', () => {
  it('sends the web document to the issuer end-session, coming back to /login', () => {
    const plan = planMiconnectSignOut(base);
    expect(plan.kind).toBe('navigate-document');
    const url = new URL((plan as { url: string }).url);
    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}end-session/`);
    expect(url.searchParams.get('id_token_hint')).toBe(base.idToken);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://canari.example/login');
  });

  it('sends a phone app through its in-app browser, coming back on the app scheme', () => {
    const plan = planMiconnectSignOut({ ...base, mobile: true });
    expect(plan.kind).toBe('in-app-browser');
    const url = new URL((plan as { url: string }).url);
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('fr.emse.canari://signed-out');
  });

  it('does not hand the document to MiConnect when the device is known to be offline', () => {
    expect(planMiconnectSignOut({ ...base, offline: true })).toEqual({
      kind: 'local-only',
      reason: 'offline',
    });
  });

  it('cannot ask without an id_token - Authentik refuses the return address without one', () => {
    expect(planMiconnectSignOut({ ...base, idToken: null })).toEqual({
      kind: 'local-only',
      reason: 'no-id-token',
    });
  });

  it('refuses an issuer on another origin than the build names', () => {
    expect(
      planMiconnectSignOut({ ...base, idToken: idToken('https://evil.example/application/o/x/') })
    ).toEqual({ kind: 'local-only', reason: 'foreign-issuer' });
  });
});

describe('from sign-in to sign-out', () => {
  beforeEach(() => {
    mobile.value = true;
    invokeMock.mockReset().mockResolvedValue(undefined);
    gotoMock.mockReset().mockResolvedValue(undefined);
    connectivity.reset();
    localStorage.clear();
  });

  /** Runs the real OIDC callback with core-service answering `body`. */
  async function signIn(body: Record<string, unknown>): Promise<void> {
    localStorage.setItem('canari_oidc_state', 'st');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    );
    await handleOidcCallback('code', 'st');
  }

  it('ends MiConnect with the id_token the sign-in kept, then goes to /login', async () => {
    const token = idToken();
    await signIn({ access_token: 'h.e30.s', id_token: token, user: { id: 'user-1' } });

    await leaveSignedOut();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe('plugin:customtabs|open_custom_tab');
    const url = new URL((args as { url: string }).url);
    expect(url.searchParams.get('id_token_hint')).toBe(token);
    expect(gotoMock).toHaveBeenCalledWith('/login', { replaceState: true });
  });

  it('uses the id_token once: a second sign-out has nothing to send and says so', async () => {
    await signIn({ access_token: 'h.e30.s', id_token: idToken(), user: { id: 'user-1' } });
    await leaveSignedOut();
    invokeMock.mockClear();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await leaveSignedOut();

    expect(invokeMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MiConnect session NOT ended'));
    expect(gotoMock).toHaveBeenLastCalledWith('/login', { replaceState: true });
    warn.mockRestore();
  });

  it('a sign-in without an id_token forgets the previous one rather than ending the wrong session', async () => {
    await signIn({ access_token: 'h.e30.s', id_token: idToken(), user: { id: 'user-1' } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await signIn({ access_token: 'h.e30.s', user: { id: 'user-2' } });

    await leaveSignedOut();

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('still completes the Canari sign-out when the in-app browser cannot open', async () => {
    await signIn({ access_token: 'h.e30.s', id_token: idToken(), user: { id: 'user-1' } });
    invokeMock.mockRejectedValue(new Error('no activity'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await leaveSignedOut();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('its session is NOT ended'));
    expect(gotoMock).toHaveBeenCalledWith('/login', { replaceState: true });
    warn.mockRestore();
  });

  it('a sign-out somebody chose revokes the session AND ends MiConnect with the kept id_token', async () => {
    // WP-T5: this was a slice of `auth.ts`'s source looking for `await leaveSignedOut()` inside
    // `signOutByChoice`; the chosen sign-out is run here instead, end to end.
    const { signOutByChoice } = await import('$lib/stores/auth');
    const token = idToken();
    await signIn({ access_token: 'h.e30.s', id_token: token, user: { id: 'user-1' } });
    const fetchMock = vi.fn((_url: RequestInfo | URL) =>
      Promise.resolve(new Response(null, { status: 204 }))
    );
    vi.stubGlobal('fetch', fetchMock);

    await signOutByChoice();

    expect(fetchMock.mock.calls.map(([url]) => String(url)).join(' ')).toContain('/auth/logout');
    // The sign-out also empties the cache's `share_out/` (the decrypted file the last share out
    // left there) and, in either mobile app, erases a share INTO Canari (`incomingShareSignOut`:
    // the epoch first, then the claim); every OTHER native call is the one that ends MiConnect.
    const shareOut = 'plugin:gallery|discard_shared_out';
    const shareIn = ['advance_share_epoch', 'read_and_clear_pending_share'];
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === shareOut)).toHaveLength(1);
    expect(
      invokeMock.mock.calls.map(([cmd]) => cmd).filter((cmd) => shareIn.includes(cmd))
    ).toEqual(shareIn);
    const ending = invokeMock.mock.calls.filter(
      ([cmd]) => cmd !== shareOut && !shareIn.includes(cmd)
    );
    expect(ending).toHaveLength(1);
    const url = new URL((ending[0]![1] as { url: string }).url);
    expect(url.searchParams.get('id_token_hint')).toBe(token);
    expect(gotoMock).toHaveBeenCalledWith('/login', { replaceState: true });
    vi.unstubAllGlobals();
  });

  it('a chosen sign-out that fails is logged as an error and told to the user, never swallowed', async () => {
    const { signOutByChoice } = await import('$lib/stores/auth');
    const { toastStore } = await import('$lib/stores/toast.svelte');
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 })))
    );
    gotoMock.mockRejectedValue(new Error('router gone'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await signOutByChoice();

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('sign-out the user chose failed'),
      expect.any(Error)
    );
    expect(toastStore.toasts.at(-1)?.type).toBe('error');
    vi.unstubAllGlobals();
  });
});

describe('a sign-in refused while the account is being erased', () => {
  it('shows the localised reason, not the server text, and says why in the log', async () => {
    const { m } = await import('$lib/paraglide/messages');
    localStorage.setItem('canari_oidc_state', 'st');
    // core-service's ForbiddenException body: the code is what the client keys on.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ code: 'ACCOUNT_ERASURE_PENDING', message: 'server text' }),
            { status: 403 }
          )
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(handleOidcCallback('code', 'st')).rejects.toThrow(
      m.auth_account_erasure_pending()
    );
    expect(warn).toHaveBeenCalledWith('[auth] sign-in refused: account erasure pending');
    warn.mockRestore();
  });
});

/**
 * WHY A SOURCE TEST (WP-T5: keep). These are the CALL SITES: five controls in components no unit
 * test mounts (a navbar, a settings panel, two gate overlays, the session shell) and one that must
 * NOT call it. What each one runs is driven above; which one a control reaches for is a statement
 * in its markup, which mounting the whole component to press one button would assert through mocks.
 */
describe('which sign-outs end MiConnect', () => {
  const src = (p: string) => readFileSync(resolvePath(__dirname, '..', '..', p), 'utf8');

  it.each(['lib/components/navigation/Navbar.svelte', 'routes/dashboard/+page.svelte'])(
    '%s - a sign-out somebody chose - goes through signOutByChoice',
    (file) => {
      const text = src(file);
      expect(text).toContain('signOutByChoice()');
      expect(text).not.toContain('leaveSignedOut');
    }
  );

  it.each([
    'lib/components/settings/SettingsDangerZone.svelte',
    'lib/components/shared/PlatformGateOverlay.svelte',
    'lib/components/shared/IdentitySplitOverlay.svelte',
  ])('%s - a sign-out somebody chose - leaves through it', (file) => {
    const text = src(file);
    expect(text).toContain('await leaveSignedOut()');
    expect(text).not.toContain("goto(resolve('/login')");
  });

  it('the PIN gate sign-out leaves through it, the dead-session logout does NOT', () => {
    const text = src('lib/components/layout/ChatBackgroundService.svelte');
    const body = (name: string) => {
      const start = text.indexOf(`async function ${name}(`);
      expect(start, `${name} not found`).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf('\n  }\n', start));
    };
    expect(body('handlePinSignOut')).toContain('await leaveSignedOut()');
    // Nobody chose to leave MiConnect there, and its cookie is what makes the sign-in one tap.
    expect(body('handleSessionExpired')).not.toContain('leaveSignedOut');
  });
});
