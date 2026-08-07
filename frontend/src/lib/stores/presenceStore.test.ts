import { get } from 'svelte/store';
import {
  checkPresenceNow,
  onPeersCameOnline,
  presenceMap,
  resetPresenceForTests,
  watchUsers,
} from './presenceStore';

vi.mock('$lib/utils/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('$lib/utils/apiUrl', () => ({ gatewayUrl: () => 'https://gw.test' }));

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
});
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
