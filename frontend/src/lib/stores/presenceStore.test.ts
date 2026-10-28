// @vitest-environment happy-dom
import { get } from 'svelte/store';
import {
  checkPresenceNow,
  onPeersCameOnline,
  PRESENCE_IDS_PER_REQUEST,
  presenceChunks,
  presenceMap,
  resetPresenceForTests,
  watchUsers,
  whenAnyComesOnline,
} from './presenceStore';

/** What `/api/version` said about `POST /api/presence`: `null` is "no answer yet". */
const capability = vi.hoisted(() => ({ presencePost: true as boolean | null }));

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/utils/apiUrl', () => ({ gatewayUrl: () => 'https://gw.test' }));
vi.mock('$lib/stores/appVersionCheck.svelte', () => ({
  serverPresencePost: () => capability.presencePost,
}));

const { apiFetch } = await import('$lib/utils/apiFetch');
const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

/** A presence response. `delayMs` keeps it open, which is what makes a poll overlap the next one. */
function presenceResponse(body: Record<string, boolean>, delayMs = 0): Promise<Response> {
  const res = new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  return delayMs === 0
    ? Promise.resolve(res)
    : new Promise((resolve) => setTimeout(() => resolve(res), delayMs));
}

/**
 * Starts watching `userIds` with a known first answer, and waits for it.
 *
 * `watchUsers` polls IMMEDIATELY (`createPausableInterval` calls its function before arming the
 * timer), so the mock has to be in place beforehand - and the `checkPresenceNow` that follows is
 * coalesced onto that very poll rather than opening a second one. Getting this wrong makes a test
 * measure a request that ran before its own fixture existed.
 */
async function startWatching(userIds: string[], answer: Record<string, boolean>): Promise<void> {
  fetchMock.mockImplementation(() => presenceResponse(answer));
  watchUsers(userIds);
  await checkPresenceNow();
}

beforeEach(() => {
  resetPresenceForTests();
  fetchMock.mockReset();
  capability.presencePost = true;
});

/** The ids one recorded call asked about, whichever route carried them. */
function idsOfCall(call: unknown[]): string[] {
  const [url, init] = call as [string, RequestInit | undefined];
  if (init?.method === 'POST') return (JSON.parse(String(init.body)) as { users: string[] }).users;
  return new URL(url).searchParams.get('users')?.split(',') ?? [];
}
afterEach(() => resetPresenceForTests());

describe('not stacking polls', () => {
  it('coalesces concurrent callers onto the request already in flight', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true }, 5_000));
    watchUsers(['user-a']);

    // A slow link: the interval fires again long before the first answer lands. Each of these was
    // measured at 32 s, so four or five could be open at once asking the identical question.
    const first = checkPresenceNow();
    const second = checkPresenceNow();
    const third = checkPresenceNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([first, second, third]);
    // Every caller still gets a settled promise - coalesced, not turned away.
    expect(get(presenceMap)['user-a']).toBe(true);
    vi.useRealTimers();
  });

  it('polls again once the previous one has settled', async () => {
    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true }));
    watchUsers(['user-a']);

    await checkPresenceNow();
    await checkPresenceNow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not open a request when nothing is watched', async () => {
    await checkPresenceNow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('noticing that a peer came back', () => {
  it('fires on the offline -> online EDGE, with the users that moved', async () => {
    const seen: string[][] = [];
    onPeersCameOnline((ids) => seen.push(ids));
    await startWatching(['user-a', 'user-b'], { 'user-a': false, 'user-b': false });
    expect(seen).toEqual([]);

    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true, 'user-b': false }));
    await checkPresenceNow();
    expect(seen).toEqual([['user-a']]);
  });

  it('stays silent for a user already known to be online', async () => {
    const seen: string[][] = [];
    onPeersCameOnline((ids) => seen.push(ids));
    await startWatching(['user-a'], { 'user-a': false });

    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true }));
    await checkPresenceNow();
    await checkPresenceNow();

    // Two polls said "online"; only the transition is news.
    expect(seen).toEqual([['user-a']]);
  });

  it('stays silent for a user seen online for the FIRST time', async () => {
    const seen: string[][] = [];
    onPeersCameOnline((ids) => seen.push(ids));

    // Never recorded as offline, so nothing "came back" - the level is not the edge, and treating
    // it as one would re-solicit history on every fresh page load.
    await startWatching(['user-a'], { 'user-a': true });
    expect(seen).toEqual([]);
  });

  it('isolates listeners: one that throws does not swallow the notification', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: string[][] = [];
    onPeersCameOnline(() => {
      throw new Error('subscriber blew up');
    });
    onPeersCameOnline((ids) => seen.push(ids));
    await startWatching(['user-a'], { 'user-a': false });

    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true }));
    await checkPresenceNow();

    expect(seen).toEqual([['user-a']]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('stops notifying once unregistered', async () => {
    const seen: string[][] = [];
    const off = onPeersCameOnline((ids) => seen.push(ids));
    await startWatching(['user-a'], { 'user-a': false });

    off();
    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true }));
    await checkPresenceNow();

    expect(seen).toEqual([]);
  });
});

describe('whenAnyComesOnline', () => {
  // The waiter reads the map, whoever writes it; the poll it starts answers nothing here, so every
  // transition below is one the test wrote.
  beforeEach(() => fetchMock.mockImplementation(() => presenceResponse({})));

  it('fires on the FIRST answer for a user this client had never polled', () => {
    // A server roster has just said they are offline; the presence poll has never seen them. The
    // poll-to-poll edge `onPeersCameOnline` reads would never fire here: there is no previous value.
    const fn = vi.fn();
    whenAnyComesOnline(['bob'], fn);

    presenceMap.set({ bob: true });

    expect(fn).toHaveBeenCalledWith(['bob']);
  });

  it('ignores a stale online value until the user has been seen offline', () => {
    // The map still says online from a poll older than the roster that said offline. Firing on it
    // would re-elect, find them offline again and park again - a loop driven by a stale value.
    presenceMap.set({ bob: true });
    const fn = vi.fn();
    whenAnyComesOnline(['bob'], fn);

    presenceMap.set({ bob: true, carol: false });
    expect(fn).not.toHaveBeenCalled();
    presenceMap.set({ bob: false, carol: false });
    expect(fn).not.toHaveBeenCalled();
    presenceMap.set({ bob: true, carol: false });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('fires once, then detaches; a cancelled waiter never fires', () => {
    const once = vi.fn();
    const cancelled = vi.fn();
    whenAnyComesOnline(['bob'], once);
    whenAnyComesOnline(['bob'], cancelled)();

    presenceMap.set({ bob: true });
    presenceMap.set({ bob: false });
    presenceMap.set({ bob: true });

    expect(once).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
  });

  it('starts polling the users it waits on', () => {
    whenAnyComesOnline(['bob'], vi.fn());
    expect(idsOfCall(fetchMock.mock.calls[0] ?? [])).toEqual(['bob']);
  });
});

describe('the presence audience (WP-PRESENCE, 2026-10-18)', () => {
  // The gateway answers only for people sharing a conversation or a community with this account:
  // anyone else is ABSENT from a 200, never a 401/403 and never `false`.

  it('drops a user the gateway stopped answering for, rather than freezing their last value', async () => {
    await startWatching(['user-a', 'user-b'], { 'user-a': true, 'user-b': true });

    fetchMock.mockImplementation(() => presenceResponse({ 'user-a': true }));
    await checkPresenceNow();

    expect(get(presenceMap)).toEqual({ 'user-a': true });
  });

  it('never reports a user it was never allowed to see, and never fires a waiter for them', async () => {
    fetchMock.mockImplementation(() => presenceResponse({}));
    const fn = vi.fn();
    whenAnyComesOnline(['stranger'], fn);
    await checkPresenceNow();

    expect('stranger' in get(presenceMap)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('keeps the map as it was on a 503 (audience unreadable) and does not throw', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await startWatching(['user-a'], { 'user-a': true });

    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'Presence audience unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    await expect(checkPresenceNow()).resolves.toBeUndefined();

    expect(get(presenceMap)).toEqual({ 'user-a': true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('503'));
    warn.mockRestore();
  });
});

describe('the ids travel in a POST body, never in the URL (2026-10-28)', () => {
  // A query string is written to every proxy's access log: a reverse-proxy log scanner flagged the
  // long ones, and the ids of everybody a member watches sat in a log of a host we do not own.
  const ID = (i: number) => i.toString(16).padStart(64, '0');

  it('POSTs the watchlist as JSON, with nothing identifying in the URL', async () => {
    await startWatching([ID(1), ID(2)], {});

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gw.test/api/presence');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ users: [ID(1), ID(2)] });
  });

  it('splits a watchlist above the cap into requests of at most the cap, in order, and merges them', async () => {
    const ids = Array.from({ length: PRESENCE_IDS_PER_REQUEST + 1 }, (_, i) => ID(i));
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      const asked = (JSON.parse(String(init.body)) as { users: string[] }).users;
      return presenceResponse(Object.fromEntries(asked.map((id) => [id, false])));
    });
    watchUsers(ids);
    await checkPresenceNow();

    const calls = fetchMock.mock.calls.map(idsOfCall);
    expect(calls.map((c) => c.length)).toEqual([PRESENCE_IDS_PER_REQUEST, 1]);
    expect(calls.flat()).toEqual(ids);
    expect(Object.keys(get(presenceMap))).toHaveLength(ids.length);
  });

  it('cuts the same watchlist the same way every time', () => {
    const ids = Array.from({ length: 2 * PRESENCE_IDS_PER_REQUEST + 3 }, (_, i) => ID(i));
    expect(presenceChunks(ids)).toEqual(presenceChunks(ids));
    expect(presenceChunks(ids).map((c) => c.length)).toEqual([
      PRESENCE_IDS_PER_REQUEST,
      PRESENCE_IDS_PER_REQUEST,
      3,
    ]);
    expect(presenceChunks([])).toEqual([]);
  });

  it('keeps the whole map when one of the requests gives no answer', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ids = Array.from({ length: PRESENCE_IDS_PER_REQUEST + 1 }, (_, i) => ID(i));
    await startWatching(ids, { [ID(0)]: true, [ID(PRESENCE_IDS_PER_REQUEST)]: true });

    let n = 0;
    fetchMock.mockImplementation(() =>
      n++ === 0
        ? presenceResponse({ [ID(0)]: false })
        : Promise.resolve(new Response('{}', { status: 503 }))
    );
    await checkPresenceNow();

    // The first half alone would have turned ID(0) off and dropped ID(1000) as "not visible".
    expect(get(presenceMap)).toEqual({ [ID(0)]: true, [ID(PRESENCE_IDS_PER_REQUEST)]: true });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('503'));
    warn.mockRestore();
  });

  it('asks nothing until /api/version has said which route this estate serves', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    capability.presencePost = null;
    fetchMock.mockImplementation(() => presenceResponse({}));
    watchUsers([ID(1)]);
    await checkPresenceNow();
    expect(fetchMock).not.toHaveBeenCalled();

    capability.presencePost = true;
    await checkPresenceNow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });

  it('uses the legacy GET, in ONE request, only on an estate whose gateway predates the POST', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    capability.presencePost = false;
    await startWatching([ID(1), ID(2)], { [ID(1)]: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(init?.method ?? 'GET').toBe('GET');
    expect(url).toBe(`https://gw.test/api/presence?users=${ID(1)},${ID(2)}`);
    expect(get(presenceMap)).toEqual({ [ID(1)]: true });
    debug.mockRestore();
  });
});
