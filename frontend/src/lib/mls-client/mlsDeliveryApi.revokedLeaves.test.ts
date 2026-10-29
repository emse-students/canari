import {
  MlsDeliveryApi,
  REVOKED_LEAVES_MAX_IDENTITIES,
  type MlsDeliveryFetch,
} from './mlsDeliveryApi';
import { DEADLINE_MS, RequestDeadlineError } from '$lib/utils/requestDeadline';

/**
 * `fetchRevokedLeaves` is the one revocation read a KEY group has. It feeds a destructive collector,
 * so it is an ALLOWLIST (only an identity it sent can come back) and it THROWS on anything that is
 * not an answer - an unanswered question must never reach the caller looking like "none revoked".
 */
function api(answer: (body: { identities: string[] }) => Response) {
  const bodies: Array<{ identities: string[] }> = [];
  const urls: string[] = [];
  const fetchImpl: MlsDeliveryFetch = async (input, init) => {
    urls.push(String(input));
    const body = JSON.parse(String(init?.body)) as { identities: string[] };
    bodies.push(body);
    return answer(body);
  };
  return {
    api: new MlsDeliveryApi({
      historyUrl: 'https://test.local',
      getToken: async () => 'tok',
      fetchImpl,
    }),
    bodies,
    urls,
  };
}

const json = (v: unknown) =>
  new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });

describe('fetchRevokedLeaves', () => {
  it('asks the group by id and keeps only identities it sent', async () => {
    const { api: a, urls } = api(() => json({ revoked: ['bob:phone-1', 'mallory:x', 7] }));

    await expect(a.fetchRevokedLeaves('kg-1', ['bob:phone-1', 'bob:web-2'])).resolves.toEqual([
      'bob:phone-1',
    ]);
    expect(urls).toEqual(['https://test.local/api/mls/groups/kg-1/revoked-leaves']);
  });

  it('chunks at the server cap rather than learning it by being refused', async () => {
    const ids = Array.from({ length: REVOKED_LEAVES_MAX_IDENTITIES + 1 }, (_, i) => `u:${i}`);
    const { api: a, bodies } = api(() => json({ revoked: [] }));

    await a.fetchRevokedLeaves('kg-1', ids);

    expect(bodies.map((b) => b.identities.length)).toEqual([REVOKED_LEAVES_MAX_IDENTITIES, 1]);
  });

  it('a HUNG read ends on the typed read deadline - it runs inside a lane that must terminate', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl: MlsDeliveryFetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        });
      const a = new MlsDeliveryApi({
        historyUrl: 'https://test.local',
        getToken: async () => 'tok',
        fetchImpl,
      });
      const asked = a.fetchRevokedLeaves('kg-1', ['bob:x']);
      const settled = asked.catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(DEADLINE_MS.read - 1);
      let done = false;
      void settled.then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);

      // The read class plus the time its few-byte body needs to leave (`deadlineFor`).
      await vi.advanceTimersByTimeAsync(1_000);
      const error = await settled;
      expect(error).toBeInstanceOf(RequestDeadlineError);
      expect((error as RequestDeadlineError).requestClass).toBe('read');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws on a refusal and on an answer that is not a list', async () => {
    const refused = api(() => new Response('{"code":"NOT_A_MEMBER"}', { status: 403 }));
    await expect(refused.api.fetchRevokedLeaves('kg-1', ['bob:x'])).rejects.toThrow('403');

    const malformed = api(() => json({ revoked: 'everyone' }));
    await expect(malformed.api.fetchRevokedLeaves('kg-1', ['bob:x'])).rejects.toThrow('no list');
  });
});
