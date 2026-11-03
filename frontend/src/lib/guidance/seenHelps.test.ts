// @vitest-environment happy-dom
/**
 * THE SEEN SET: the server's answer is the truth, the local copy is optimistic, an unanswered write
 * is owed to the reconnect or the next opening (never a timer), and only the typed unknown-id
 * refusal is dropped - every other status stays owed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransportFailureError } from '$lib/utils/transportFailure';

const apiFetch = vi.fn();
const reconnectListeners: (() => void)[] = [];

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock('$lib/utils/apiUrl', () => ({ coreUrl: () => 'https://core.test' }));
vi.mock('$lib/utils/Log', () => ({ Log: { d: () => {}, i: () => {} } }));
vi.mock('$lib/stores/connectivity.svelte', () => ({
  connectivity: {
    onReconnect: (listener: () => void) => {
      reconnectListeners.push(listener);
      return () => {
        const i = reconnectListeners.indexOf(listener);
        if (i >= 0) reconnectListeners.splice(i, 1);
      };
    },
  },
}));

const { SeenHelps } = await import('./seenHelps.svelte');
const { ACCOUNT_KEY } = await import('$lib/utils/accountLocalKeys');

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe('SeenHelps', () => {
  let store: InstanceType<typeof SeenHelps>;

  beforeEach(() => {
    localStorage.clear();
    apiFetch.mockReset();
    reconnectListeners.length = 0;
    store = new SeenHelps();
  });

  afterEach(() => vi.restoreAllMocks());

  it('is ready only once the server answered, and merges its set', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { seen: ['welcome-tour', 'retired'] }));
    const loading = store.load('u1');
    expect(store.ready).toBe(false);
    await loading;
    expect(store.ready).toBe(true);
    expect(store.has('welcome-tour')).toBe(true);
    expect(apiFetch).toHaveBeenCalledWith('https://core.test/api/users/me/help-seen');
  });

  it('records optimistically, then on the server', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    await store.load('u1');
    apiFetch.mockResolvedValueOnce(json(200, { success: true }));
    store.markSeen('welcome-tour');
    expect(store.has('welcome-tour')).toBe(true);
    await flush();
    expect(apiFetch).toHaveBeenLastCalledWith(
      'https://core.test/api/users/me/help-seen/welcome-tour',
      { method: 'POST' }
    );
    expect(store.owed).toEqual([]);
    expect(JSON.parse(localStorage.getItem(ACCOUNT_KEY.seenHelps('u1'))!)).toEqual({
      seen: ['welcome-tour'],
      owed: [],
    });
  });

  it('owes an unanswered write to the reconnect, and delivers it there', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    await store.load('u1');
    apiFetch.mockRejectedValueOnce(new TransportFailureError('offline'));
    store.markSeen('welcome-tour');
    await flush();
    expect(store.owed).toEqual(['welcome-tour']);
    expect(reconnectListeners).toHaveLength(1);

    apiFetch.mockResolvedValueOnce(json(200, { success: true }));
    reconnectListeners[0]();
    await flush();
    expect(store.owed).toEqual([]);
    expect(reconnectListeners).toHaveLength(0);
  });

  it('keeps an owed write across a reload and delivers it at the next opening', async () => {
    localStorage.setItem(
      ACCOUNT_KEY.seenHelps('u1'),
      JSON.stringify({ seen: ['welcome-tour'], owed: ['welcome-tour'] })
    );
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    apiFetch.mockResolvedValueOnce(json(200, { success: true }));
    await store.load('u1');
    expect(store.has('welcome-tour')).toBe(true);
    expect(apiFetch).toHaveBeenNthCalledWith(
      2,
      'https://core.test/api/users/me/help-seen/welcome-tour',
      { method: 'POST' }
    );
    expect(store.owed).toEqual([]);
  });

  it.each([
    ['a throttled write', 429, { message: 'ThrottlerException: Too Many Requests' }],
    ['a timed-out request', 408, {}],
    ['a 400 with another code', 400, { code: 'SOMETHING_ELSE' }],
    ['a refused session', 401, {}],
    ['a server failure', 503, {}],
  ])('keeps %s owed, and delivers it at the next opening', async (_label, status, body) => {
    const warns = vi.spyOn(console, 'warn').mockImplementation(() => {});
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    await store.load('u1');
    apiFetch.mockResolvedValueOnce(json(status, body));
    store.markSeen('welcome-tour');
    await flush();
    expect(store.owed).toEqual(['welcome-tour']);
    expect(warns).toHaveBeenCalled();

    // The next opening reads, then delivers what is owed.
    const fresh = new SeenHelps();
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    apiFetch.mockResolvedValueOnce(json(200, { success: true }));
    await fresh.load('u1');
    expect(apiFetch).toHaveBeenLastCalledWith(
      'https://core.test/api/users/me/help-seen/welcome-tour',
      { method: 'POST' }
    );
    expect(fresh.owed).toEqual([]);
  });

  it('drops only the typed unknown-id refusal, and accuses it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    await store.load('u1');
    apiFetch.mockResolvedValueOnce(json(400, { code: 'HELP_ID_UNKNOWN' }));
    store.markSeen('welcome-tour');
    await flush();
    expect(store.owed).toEqual([]);
    expect(store.has('welcome-tour')).toBe(true);
    expect(reconnectListeners).toHaveLength(0);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it('reads again at the reconnect when the first read met no answer', async () => {
    apiFetch.mockRejectedValueOnce(new TransportFailureError('offline'));
    await store.load('u1');
    expect(store.ready).toBe(false);
    apiFetch.mockResolvedValueOnce(json(200, { seen: ['welcome-tour'] }));
    reconnectListeners[0]();
    await flush();
    expect(store.ready).toBe(true);
    expect(store.has('welcome-tour')).toBe(true);
  });

  it('keys the seen record per account: one account having seen the tour says nothing of another', async () => {
    apiFetch.mockResolvedValueOnce(json(200, { seen: ['welcome-tour'] }));
    await store.load('u1');
    expect(store.has('welcome-tour')).toBe(true);
    store.reset();
    // u2 signs in on the same device: its own server answer and its own local copy decide.
    apiFetch.mockResolvedValueOnce(json(200, { seen: [] }));
    await store.load('u2');
    expect(store.ready).toBe(true);
    expect(store.has('welcome-tour')).toBe(false);
    expect(localStorage.getItem(ACCOUNT_KEY.seenHelps('u2'))).not.toContain('welcome-tour');
  });

  it('forgets the account on reset, and drops an answer that belongs to it', async () => {
    let answer: (r: Response) => void = () => {};
    apiFetch.mockReturnValueOnce(new Promise<Response>((r) => (answer = r)));
    const loading = store.load('u1');
    store.reset();
    answer(json(200, { seen: ['welcome-tour'] }));
    await loading;
    expect(store.ready).toBe(false);
    expect(store.has('welcome-tour')).toBe(false);
  });
});
