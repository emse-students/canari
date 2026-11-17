import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getToken, SessionExpiredError, setToken } from '$lib/stores/auth';

/**
 * A REFUSED LIFT IS AN ANSWER, NEVER A SIGN-OUT (CLAUDE.md: only a 401 may end a session, and only
 * after the renewal said so). The staff lift of a broadcaster's withdrawal goes through the real
 * `apiFetch` here, with only the network stubbed: a 403 must come back as the typed lives refusal
 * the moderation row sentences, with no token renewal attempted and the session's token kept.
 */
vi.mock('$lib/utils/apiUrl', () => ({
  socialUrl: () => 'https://social.test',
  mediaUrl: () => 'https://media.test',
}));

import { liftBroadcasterWithdrawal, LiveRefusalError } from './api';

/** A token `getToken` hands straight back, so any refresh in the run would be the 403's doing. */
function freshAccessToken(): string {
  const claims = btoa(
    JSON.stringify({ sub: 'staff-1', exp: Math.floor(Date.now() / 1000) + 3600 })
  );
  return `h.${claims}.s`;
}

const fetchMock = vi.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({ code: 'MODERATION_OUT_OF_SCOPE' }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    })
);

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a 403 on the lift of a withdrawal', () => {
  it('is the typed refusal, with no renewal and the session kept', async () => {
    const token = freshAccessToken();
    setToken(token);
    const error = await liftBroadcasterWithdrawal('u9').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveRefusalError);
    expect(error).not.toBeInstanceOf(SessionExpiredError);
    expect((error as LiveRefusalError).code).toBe('MODERATION_OUT_OF_SCOPE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://social.test/api/lives/broadcasters/u9/withdrawal'
    );
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/api/auth/'))).toBe(false);
    expect(await getToken()).toBe(token);
  });
});
