const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
let android = true;
vi.mock('$lib/utils/appVersion', () => ({ isAndroidTauriRuntime: () => android }));
const adoptRestoredSession = vi.fn();
vi.mock('$lib/stores/auth', () => ({
  adoptRestoredSession: (...args: unknown[]) => adoptRestoredSession(...args),
}));
const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/services/authSessions', () => ({
  sessionScopedHeaders: async (base: Record<string, string> = {}) => base,
}));

import { attemptRestore, ensureRestoreKey } from './restoreCredential';
import {
  RESTORE_ATTEMPTED_KEY,
  RESTORE_REGISTERED_PREFIX,
  forgetRestoreKeyRegistrations,
  rememberRegisteredRestoreKey,
} from './restoreKey';
import { TransportFailureError } from '$lib/utils/transportFailure';
import { m } from '$lib/paraglide/messages';

/**
 * The client half of WP-RESTORE-1 (docs/wiki/account-restore.md): WHEN a key is registered, WHEN a
 * restore is attempted, what each refusal does to the local key and to the once-per-install marker.
 * The platform (`invoke`) and the server (`fetch`, `apiFetch`) are doubles; the WebAuthn itself is
 * the server's spec.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const SESSION = {
  access_token: 'at',
  user: { id: 'user-1234567890', email: '', displayName: 'U' },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  android = true;
  invoke.mockReset();
  adoptRestoredSession.mockReset().mockResolvedValue(undefined);
  apiFetch.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Routes `invoke` by command name. */
function platform(answers: { create?: unknown; get?: unknown; getThrows?: unknown }) {
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'plugin:restore|create_restore_credential') return answers.create;
    if (cmd === 'plugin:restore|get_restore_credential') {
      if (answers.getThrows) throw answers.getThrows;
      return answers.get;
    }
    if (cmd === 'plugin:restore|clear_restore_credential') return undefined;
    throw new Error(`unexpected command ${cmd}`);
  });
}

const cleared = () =>
  invoke.mock.calls.some(([cmd]) => cmd === 'plugin:restore|clear_restore_credential');

describe('ensureRestoreKey', () => {
  /** The options answer: the WebAuthn options and the key the session holds now. */
  const options = (registeredCredentialId: string | null) =>
    json({ options: { challenge: 'c' }, registeredCredentialId });

  it('registers when the session holds no key: options, the platform key, the server - and remembers the id', async () => {
    platform({ create: { responseJson: '{"id":"k"}', cloudBackup: true } });
    apiFetch
      .mockResolvedValueOnce(options(null))
      .mockResolvedValueOnce(json({ registered: true, credentialId: 'k' }));

    await ensureRestoreKey('user-1');

    expect(apiFetch.mock.calls[0][0]).toBe(
      'https://core.test/api/auth/restore/registration/options'
    );
    // `credentials: 'include'` is what keeps it on the WebView's fetch, hence the app's Origin.
    expect(apiFetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include' });
    expect(invoke).toHaveBeenCalledWith('plugin:restore|create_restore_credential', {
      requestJson: JSON.stringify({ challenge: 'c' }),
    });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toEqual({
      response: { id: 'k' },
      cloudBackup: true,
      previousCredentialId: null,
    });
    expect(localStorage.getItem(RESTORE_REGISTERED_PREFIX + 'user-1')).toBe('k');
  });

  it('asks at EVERY start, and stops there when the session holds the key this install registered', async () => {
    rememberRegisteredRestoreKey('user-1', 'k');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    apiFetch.mockResolvedValueOnce(options('k'));
    await ensureRestoreKey('user-1');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('accuses and REPLACES a key this install did not register (planted with the session)', async () => {
    rememberRegisteredRestoreKey('user-1', 'mine');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    platform({ create: { responseJson: '{"id":"fresh"}', cloudBackup: true } });
    apiFetch
      .mockResolvedValueOnce(options('planted-key'))
      .mockResolvedValueOnce(json({ registered: true, credentialId: 'fresh' }));

    await ensureRestoreKey('user-1');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('did not register'));
    // The server is told which key this install believes it replaces, so it can accuse the other.
    expect(JSON.parse(apiFetch.mock.calls[1][1].body).previousCredentialId).toBe('mine');
    expect(localStorage.getItem(RESTORE_REGISTERED_PREFIX + 'user-1')).toBe('fresh');
  });

  it('carries the second path (no cloud backup) to the server as it happened', async () => {
    platform({ create: { responseJson: '{}', cloudBackup: false } });
    apiFetch
      .mockResolvedValueOnce(options(null))
      .mockResolvedValueOnce(json({ registered: true, credentialId: 'k' }));
    await ensureRestoreKey('user-1');
    expect(JSON.parse(apiFetch.mock.calls[1][1].body).cloudBackup).toBe(false);
  });

  it('leaves the marker unset on a refusal, so the next start tries again', async () => {
    platform({ create: { responseJson: '{}', cloudBackup: true } });
    apiFetch
      .mockResolvedValueOnce(options(null))
      .mockResolvedValueOnce(json({ code: 'RESTORE_KEY_TAKEN', message: 'x' }, 403));
    await expect(ensureRestoreKey('user-1')).rejects.toMatchObject({
      refusal: { status: 403, code: 'RESTORE_KEY_TAKEN' },
    });
    expect(localStorage.getItem(RESTORE_REGISTERED_PREFIX + 'user-1')).toBeNull();
  });

  it('does nothing off Android', async () => {
    android = false;
    await ensureRestoreKey('user-1');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a new session drops the marker of the previous one', () => {
    rememberRegisteredRestoreKey('user-1', 'a');
    rememberRegisteredRestoreKey('user-2', 'b');
    localStorage.setItem('unrelated', 'kept');
    forgetRestoreKeyRegistrations();
    expect(localStorage.getItem(RESTORE_REGISTERED_PREFIX + 'user-1')).toBeNull();
    expect(localStorage.getItem(RESTORE_REGISTERED_PREFIX + 'user-2')).toBeNull();
    expect(localStorage.getItem('unrelated')).toBe('kept');
  });
});

describe('attemptRestore', () => {
  it('restores: options, the platform signs, the server answers a session that is adopted', async () => {
    platform({ get: { absent: false, responseJson: '{"id":"k"}' } });
    fetchMock.mockResolvedValueOnce(json({ challenge: 'c' })).mockResolvedValueOnce(json(SESSION));

    await expect(attemptRestore()).resolves.toEqual({
      outcome: 'restored',
      userId: 'user-1234567890',
    });
    expect(fetchMock.mock.calls[1][0]).toBe('https://core.test/api/auth/restore/assertion');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ response: { id: 'k' } });
    expect(adoptRestoredSession).toHaveBeenCalledWith(SESSION);
  });

  it('records "nothing to restore" as an answer, and never asks again', async () => {
    platform({ get: { absent: true } });
    fetchMock.mockResolvedValue(json({ challenge: 'c' }));
    await expect(attemptRestore()).resolves.toEqual({ outcome: 'nothing-to-restore' });
    expect(localStorage.getItem(RESTORE_ATTEMPTED_KEY)).not.toBeNull();

    await expect(attemptRestore()).resolves.toEqual({ outcome: 'not-applicable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('records nothing on a transport failure, so the next visit asks again', async () => {
    fetchMock.mockRejectedValueOnce(new TransportFailureError('reqwest: connection refused'));
    await expect(attemptRestore()).resolves.toEqual({ outcome: 'unreachable' });
    expect(localStorage.getItem(RESTORE_ATTEMPTED_KEY)).toBeNull();
  });

  it('clears the local key the server no longer knows, and records the attempt', async () => {
    platform({ get: { absent: false, responseJson: '{}' } });
    fetchMock
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ code: 'RESTORE_KEY_UNKNOWN', message: 'x' }, 401));
    await expect(attemptRestore()).resolves.toMatchObject({
      outcome: 'refused',
      code: 'RESTORE_KEY_UNKNOWN',
    });
    expect(cleared()).toBe(true);
    expect(localStorage.getItem(RESTORE_ATTEMPTED_KEY)).not.toBeNull();
  });

  it('accuses a registered key that did not verify, and keeps it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    platform({ get: { absent: false, responseJson: '{}' } });
    fetchMock
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ code: 'RESTORE_ASSERTION_INVALID', message: 'x' }, 401));
    await attemptRestore();
    expect(error).toHaveBeenCalled();
    expect(cleared()).toBe(false);
  });

  it('leaves the attempt un-recorded when the estate cannot answer (unconfigured)', async () => {
    fetchMock.mockResolvedValueOnce(json({ code: 'RESTORE_UNAVAILABLE', message: 'x' }, 503));
    await expect(attemptRestore()).resolves.toMatchObject({ code: 'RESTORE_UNAVAILABLE' });
    expect(localStorage.getItem(RESTORE_ATTEMPTED_KEY)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('shows the MiConnect sign-in sentence for an erasure in progress', async () => {
    platform({ get: { absent: false, responseJson: '{}' } });
    fetchMock
      .mockResolvedValueOnce(json({}))
      .mockResolvedValueOnce(json({ code: 'ACCOUNT_ERASURE_PENDING', message: 'x' }, 403));
    await expect(attemptRestore()).resolves.toEqual({
      outcome: 'refused',
      code: 'ACCOUNT_ERASURE_PENDING',
      shown: m.auth_account_erasure_pending(),
    });
    expect(adoptRestoredSession).not.toHaveBeenCalled();
  });

  it('accuses a platform that failed to answer, distinct from "no key"', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    platform({ getThrows: 'getRestoreCredential failed (TYPE_UNKNOWN): boom' });
    fetchMock.mockResolvedValueOnce(json({}));
    await expect(attemptRestore()).resolves.toMatchObject({ outcome: 'refused', code: null });
    expect(error).toHaveBeenCalled();
  });

  it('asks nothing off Android', async () => {
    android = false;
    await expect(attemptRestore()).resolves.toEqual({ outcome: 'not-applicable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
