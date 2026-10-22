import type { EncryptedGraineRow } from '$lib/db/types';
import {
  boundGraineRetentionDays,
  GRAINE_RETENTION_FLOOR_DAYS,
  sweepExpiredGraineSeeds,
} from './retention';
import { cacheGraineSession, cachedGraineSession, setGraineRuntime } from './runtime';

/**
 * Seeds do not outlive the messages they open.
 *
 * The window is the SERVER's, and the sweep asks rather than re-deriving it - the whole point being
 * that a pinned message exempt from the purge keeps its own seed, which a matching client-side
 * timer would have deleted. The tests that matter here are the ones about what must NOT be dropped:
 * a young session with no messages yet, anything at all when the answer never arrived, and
 * anything younger than the client floor whatever window the server states.
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
    deviceKey: () => 'device-key',
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

  it.each([0, -30, 1, 7, 364])(
    'never sweeps a seed younger than the client floor when the server answers retentionDays=%d',
    async (hostile) => {
      // The window is the server's to state, but not the server's to SHRINK on a device: a value
      // below the floor would make every device drop every seed older than it, the whole history
      // of every salon. The floor is the product's own window, so it changes nothing honest.
      rows = [mkRow('s-day', 1), mkRow('s-month', 30), mkRow('s-nearly', 364)];
      liveGraineSessions.mockResolvedValue({ live: [], retentionDays: hostile });
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

      expect(deleted).toEqual([]);
      expect(forgetMirrored).not.toHaveBeenCalled();
      // The out-of-bound answer accuses the server; it is not a quiet correction.
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`retentionDays=${hostile}`));
      error.mockRestore();
    }
  );

  it('still sweeps past the floor when the server answers below it', async () => {
    // Clamped, not refused: a seed older than the product window whose messages are gone is still
    // the liability this sweep exists to drop.
    rows = [mkRow('s-young', 10), mkRow('s-old', 400)];
    liveGraineSessions.mockResolvedValue({ live: [], retentionDays: 1 });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(1);

    expect(deleted).toEqual([['s-old']]);
    error.mockRestore();
  });

  it('refuses to sweep when the server window is not a number at all', async () => {
    rows = [mkRow('s-old', 400)];
    liveGraineSessions.mockResolvedValue({ live: [], retentionDays: Number.NaN });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(sweepExpiredGraineSeeds()).resolves.toBe(0);

    expect(deleted).toEqual([]);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('retentionDays=NaN'));
    error.mockRestore();
  });

  it('bounds the window from below only', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // At the floor and above it the server's value is used as is, silently: an honest answer.
    expect(boundGraineRetentionDays(GRAINE_RETENTION_FLOOR_DAYS)).toBe(GRAINE_RETENTION_FLOOR_DAYS);
    expect(boundGraineRetentionDays(400)).toBe(400);
    expect(error).not.toHaveBeenCalled();

    expect(boundGraineRetentionDays(GRAINE_RETENTION_FLOOR_DAYS - 1)).toBe(
      GRAINE_RETENTION_FLOOR_DAYS
    );
    expect(boundGraineRetentionDays(Number.POSITIVE_INFINITY)).toBeNull();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
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
