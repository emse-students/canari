import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.fn();
vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('$lib/stores/auth', () => ({ getToken: async () => 'tok' }));
vi.mock('$lib/utils/apiUrl', () => ({ socialUrl: () => 'http://social' }));

import { CLIENT_VERSION_HEADER, getClientAppVersion } from '$lib/utils/appVersion';
import { submitForm, submitPublicForm } from './api';

/**
 * A SUBMIT NAMES THIS BUILD (`X-Canari-Client-Version`): the server takes an answer WITHOUT the
 * declared fields only from a build older than the questions that ask them
 * (social-service `respondent-identity.ts`, `predatesDeclaredFields`). A build that drew them and
 * did not name itself would be taken for an older one and its missing answers marked "not declared".
 */
describe('a form submit names the build that sends it', () => {
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const fetchSpy = vi.fn();
  beforeEach(() => {
    apiFetch.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("names it on a member's submit", async () => {
    apiFetch.mockResolvedValue(ok());
    await submitForm('f1', { answers: {} });
    const [, init] = apiFetch.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)[CLIENT_VERSION_HEADER]).toBe(
      getClientAppVersion()
    );
  });

  it("names it on a guest's submit", async () => {
    fetchSpy.mockResolvedValue(ok());
    await submitPublicForm('f1', { answers: {}, website: '' });
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers[CLIENT_VERSION_HEADER]).toBe(getClientAppVersion());
    expect(headers['Content-Type']).toBe('application/json');
  });
});
