import type { EncryptedGraineRow } from '$lib/db/types';
import { sweepExpiredGraineSeeds } from './retention';
import { cacheGraineSession, cachedGraineSession, setGraineRuntime } from './runtime';

/**
 * Seeds do not outlive the messages they open.
 *
 * The window is the SERVER's, and the sweep asks rather than re-deriving it - the whole point being
 * that a pinned message exempt from the purge keeps its own seed, which a matching client-side
 * timer would have deleted. The tests that matter here are the ones about what must NOT be dropped:
 * a young session with no messages yet, and anything at all when the answer never arrived.
 */

const liveGraineSessions = vi.fn();
vi.mock('$lib/services/ChannelService', () => ({
  channelService: {
    liveGraineSessions: (...args: unknown[]) => liveGraineSessions(...args),
  },
}));

const forgetMirrored = vi.fn();
vi.mock('./graineMirror', () => ({
  mirrorGraineSeed: vi.fn(),
  forgetGraineChannelMirror: vi.fn(),
  forgetGraineMirroredSessions: (ids: readonly string[]) => forgetMirrored(ids),
}));

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW = 1_800_000_000_000;

/** A stored row as the sweep reads it: id and age, never the seed. */
function mkRow(sessionId: string, ageDays: number): EncryptedGraineRow {
  return {
    sessionId,
    workspaceId: 'ws-1',
    channelId: 'chan-1',
    senderId: 'bob',
    firstIndex: 0,
    createdAt: NOW - ageDays * DAY_MS,
    iv: new Uint8Array(12),
    cipherText: new Uint8Array(16),
  };
}

let rows: EncryptedGraineRow[];
let deleted: string[][];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  liveGraineSessions.mockReset();
  forgetMirrored.mockReset();
  rows = [];
  deleted = [];
  liveGraineSessions.mockResolvedValue({ live: [], retentionDays: 365 });
  setGraineRuntime({
    storage: {
      getAllEncryptedGraineRows: async () => rows.slice(),
      deleteGraineSessions: async (ids: readonly string[]) => {
        deleted.push([...ids]);
        rows = rows.filter((r) => !ids.includes(r.sessionId));
        return ids.length;
      },
    } as never,
    deviceKeyB64: 'device-key',
    userId: 'alice',
    mlsService: {} as never,
  });
});

afterEach(() => {
  setGraineRuntime(null);
  vi.useRealTimers();
});

describe('sweepExpiredGraineSeeds', () => {
  it('drops a seed the server no longer has any message for', async () => {
    rows = [mkRow('s-old', 400)];
    cacheGraineSession({
      workspaceId: 'ws-1',
      channelId: 'chan-1',
      sessionId: 's-old',
      senderId: 'bob',
      seedB64: 'seed',
      firstIndex: 0,
      createdAt: NOW - 400 * DAY_MS,
    });

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(1);

    expect(deleted).toEqual([['s-old']]);
    // All three stores or none: the cache is what this tab answers from until it reloads, and the
    // native mirror is what a background push reads with the app killed.
    expect(cachedGraineSession('s-old')).toBeNull();
    expect(forgetMirrored).toHaveBeenCalledWith(['s-old']);
  });

  it('KEEPS a session the server still names, however old it is', async () => {
    // This is the pinned-message case: the purge spared the message, so the session is still live.
    rows = [mkRow('s-pinned', 900)];
    liveGraineSessions.mockResolvedValue({ live: ['s-pinned'], retentionDays: 365 });

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

    expect(deleted).toEqual([]);
    expect(forgetMirrored).not.toHaveBeenCalled();
  });

  it('KEEPS a young session with no messages yet', async () => {
    // "No message names this session" has two causes the answer cannot separate: its messages
    // expired, or it has none yet. Age is what tells them apart, and a session minted this morning
    // whose first send has not landed must survive.
    rows = [mkRow('s-fresh', 0), mkRow('s-yesterday', 1), mkRow('s-nearly', 364)];

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

    expect(deleted).toEqual([]);
  });

  it('refuses to sweep anything when a chunk went unanswered', async () => {
    rows = [mkRow('s-old', 400)];
    liveGraineSessions.mockRejectedValue(new Error('502'));

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

    // A failed ask reads exactly like "the server names nothing", and acting on it would delete
    // every seed on the device the first time the API is down.
    expect(deleted).toEqual([]);
  });

  it('refuses to sweep when the server gives no usable window', async () => {
    rows = [mkRow('s-old', 400)];
    liveGraineSessions.mockResolvedValue({ live: [], retentionDays: 0 });

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

    // Fail closed: with a zero window every session looks old enough, and the sweep would take the
    // seed of every salon this device has not yet posted in.
    expect(deleted).toEqual([]);
  });

  it('asks in bounded chunks the server will accept', async () => {
    rows = Array.from({ length: 501 }, (_, i) => mkRow(`s-${i}`, 400));

    await sweepExpiredGraineSeeds();

    expect(liveGraineSessions).toHaveBeenCalledTimes(2);
    expect((liveGraineSessions.mock.calls[0]![0] as string[]).length).toBe(500);
    expect((liveGraineSessions.mock.calls[1]![0] as string[]).length).toBe(1);
    // Every chunk's verdict is applied, not just the last one's.
    expect(deleted[0]).toHaveLength(501);
  });

  it('does nothing at all when the device holds no seeds', async () => {
    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);
    expect(liveGraineSessions).not.toHaveBeenCalled();
  });

  it('says so rather than running with no Graine runtime', async () => {
    setGraineRuntime(null);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Graine runtime'));
    warn.mockRestore();
  });
});
