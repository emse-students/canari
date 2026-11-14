/**
 * THE ADMIN RETENTION DURATIONS, STAMPED AT CREATION (owner, 2026-11-14; docs/wiki/retention-settings.md).
 *
 * Pinned, each because the opposite is a plausible mistake:
 *  - an `ephemeral` upload carries the idle window IN FORCE at its upload, and the sweep reads it -
 *    a window read at the sweep would apply a lowered duration to every file already stored;
 *  - a file uploaded before the setting keeps the 90 days it was promised;
 *  - a `chat-reel` upload is due one window (in force) after its upload, written as its hold;
 *  - a duration that cannot be read REFUSES the upload with nothing stored - never a default;
 *  - the durations are HELD in memory: social-service down after the boot read leaves uploads
 *    stamped with the last values, and a notice applies a new value to the next upload - no upload
 *    waits on a network call (lead's decision after the review of #3521).
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { MediaService } from './media.service';
import {
  MediaRetentionHolder,
  RetentionBootstrap,
  fetchMediaRetention,
  mediaRetention,
  type MediaRetentionDays,
} from './retention-settings';

const DAY = 24 * 60 * 60 * 1000;

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  retentionClass?: string;
  ownerId?: string;
  idleRetentionMs?: number;
  holds?: { post: boolean; chat: { heldAt: number; dueAt: number } | null };
};

type Internals = {
  meta: { items: Record<string, Entry> };
  storage: Record<string, unknown>;
  logger: Record<string, () => void>;
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  sweepIntervalMs: number;
  uploadLocks: Map<string, Promise<void>>;
};

function serviceWith(items: Record<string, Entry>) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const internals = service as unknown as Internals;
  const deleted: string[] = [];
  const put: string[] = [];
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
    put: (id: string) => {
      put.push(id);
      return Promise.resolve();
    },
    listObjects: () => Promise.resolve([]),
  };
  internals.logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
  internals.uploadLocks = new Map();
  internals.persistMetadata = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, internals, deleted, put };
}

const answer = (chatReelDays: number, idleFileDays: number) =>
  jest.spyOn(MediaService.prototype, 'readRetention').mockReturnValue({
    chatReelDays,
    idleFileDays,
  });

describe('an ephemeral upload carries the idle window in force at its upload', () => {
  it('stamps the setting, and the sweep keeps it past the old 90 days when the setting was raised', async () => {
    answer(30, 120);
    const items: Record<string, Entry> = {};
    const { service, internals, deleted } = serviceWith(items);

    const id = await service.upload(Buffer.alloc(10), 'alice', 'ephemeral');
    expect(items[id].idleRetentionMs).toBe(120 * DAY);

    // Idle 100 days: past the old 90, within the 120 it was uploaded under.
    items[id].lastAccessAt = Date.now() - 100 * DAY;
    // The setting is LOWERED afterwards: the file keeps the window it was stamped with.
    answer(30, 10);
    await internals.purgeExpiredMedia();
    expect(deleted).toEqual([]);

    items[id].lastAccessAt = Date.now() - 121 * DAY;
    await internals.purgeExpiredMedia();
    expect(deleted).toEqual([id]);
  });

  it('a file uploaded before the setting (no stamp) keeps the 90 days it was promised', async () => {
    const items: Record<string, Entry> = {
      a: { createdAt: 0, lastAccessAt: Date.now() - 89 * DAY, retentionClass: 'ephemeral' },
      b: { createdAt: 0, lastAccessAt: Date.now() - 91 * DAY, retentionClass: 'ephemeral' },
    };
    const { internals, deleted } = serviceWith(items);
    await internals.purgeExpiredMedia();
    expect(deleted).toEqual(['b']);
  });
});

describe('a chat-reel upload is due one window in force after it', () => {
  it('writes the hold at upload with the setting, and a later change moves nothing', async () => {
    answer(7, 90);
    const items: Record<string, Entry> = {};
    const { service } = serviceWith(items);
    const before = Date.now();

    const id = await service.upload(Buffer.alloc(10), 'alice', 'chat-reel');

    const hold = items[id].holds?.chat;
    expect(items[id].retentionClass).toBe('chat-reel');
    expect(hold?.dueAt).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(hold!.dueAt - hold!.heldAt).toBe(7 * DAY);
  });

  it('a class no admin duration decides reads nothing', async () => {
    const read = answer(7, 90);
    read.mockClear();
    const { service } = serviceWith({});
    await service.upload(Buffer.alloc(10), 'alice', 'archive');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('a duration that cannot be read refuses the upload', () => {
  it('stores nothing and registers nothing', async () => {
    jest.spyOn(MediaService.prototype, 'readRetention').mockImplementation(() => {
      throw new ServiceUnavailableException();
    });
    const items: Record<string, Entry> = {};
    const { service, put } = serviceWith(items);

    await expect(service.upload(Buffer.alloc(10), 'alice', 'ephemeral')).rejects.toBeInstanceOf(
      ServiceUnavailableException
    );
    expect(put).toEqual([]);
    expect(items).toEqual({});
  });
});

describe('fetchMediaRetention - the relay read, failing closed', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });
  const relayAnswers = (status: number, body: unknown) => {
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(JSON.stringify(body), { status }))
    ) as typeof fetch;
  };

  it('reads the two durations social-service relays', async () => {
    relayAnswers(200, { chatReelDays: 14, idleFileDays: 60, reelDays: 365 });
    await expect(fetchMediaRetention()).resolves.toEqual({
      chatReelDays: 14,
      idleFileDays: 60,
    });
  });

  it('answers 503 on a refusal or an unreachable relay', async () => {
    relayAnswers(500, {});
    await expect(fetchMediaRetention()).rejects.toBeInstanceOf(ServiceUnavailableException);
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    const refused = fetchMediaRetention();
    await expect(refused).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(refused).rejects.toThrow(/ECONNREFUSED/);
  });

  it.each([0, 1.5, '30', null])('THROWS on an unusable value %p, never a default', async (bad) => {
    relayAnswers(200, { chatReelDays: bad, idleFileDays: 90 });
    await expect(fetchMediaRetention()).rejects.toThrow(/chatReelDays/);
  });
});

describe('MediaRetentionHolder - the durations held in memory', () => {
  const logs = () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });
  const values = (chatReelDays: number, idleFileDays: number): MediaRetentionDays => ({
    chatReelDays,
    idleFileDays,
  });

  it('refuses with a 503 before any read, and asks for exactly one read beside the upload', async () => {
    const read = jest.fn(() => Promise.resolve(values(30, 90)));
    const logger = logs();
    const holder = new MediaRetentionHolder(read, logger);

    expect(() => holder.require()).toThrow(ServiceUnavailableException);
    expect(() => holder.require()).toThrow(ServiceUnavailableException);
    await holder.refresh('demand');
    expect(read).toHaveBeenCalledTimes(1);
    expect(holder.require()).toEqual(values(30, 90));
  });

  it('keeps the last values when social-service is down after the boot read, and says how old they are', async () => {
    let now = 1_000_000;
    const read = jest
      .fn<Promise<MediaRetentionDays>, []>()
      .mockResolvedValueOnce(values(14, 60))
      .mockRejectedValue(new ServiceUnavailableException());
    const logger = logs();
    const holder = new MediaRetentionHolder(read, logger, () => now);

    expect(await holder.refresh('boot')).toBe(true);
    now += 120_000;
    expect(await holder.refresh('notice')).toBe(false);
    expect(holder.require()).toEqual(values(14, 60));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('values read 120 s ago'));
  });

  it('logs an outage once when it starts and once when it ends - a refused upload is a debug line', async () => {
    let now = 1_000_000;
    const read = jest
      .fn<Promise<MediaRetentionDays>, []>()
      .mockRejectedValueOnce(new ServiceUnavailableException('social-service unreachable'))
      .mockRejectedValueOnce(new ServiceUnavailableException('social-service unreachable'))
      .mockRejectedValueOnce(new ServiceUnavailableException('social-service unreachable'))
      .mockResolvedValue(values(30, 90));
    const logger = logs();
    const holder = new MediaRetentionHolder(read, logger, () => now);

    await holder.refresh('boot');
    for (let upload = 0; upload < 2; upload++) {
      expect(() => holder.require()).toThrow(ServiceUnavailableException);
      await holder.refresh('demand');
    }
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('upload refused'));

    now += 45_000;
    expect(() => holder.require()).toThrow(ServiceUnavailableException);
    await holder.refresh('demand');
    expect(holder.require()).toEqual(values(30, 90));
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('readable again (demand) after 45 s: 3 upload(s) refused meanwhile')
    );
  });

  it('a notice never joins a read already running: it gets a fresh one, and the new values', async () => {
    const answers: Array<(v: MediaRetentionDays) => void> = [];
    const read = jest.fn(() => new Promise<MediaRetentionDays>((r) => answers.push(r)));
    const holder = new MediaRetentionHolder(read, logs());

    // A demand read is running; it asked social-service BEFORE the admin's update committed.
    const demand = holder.refresh('demand');
    const notice = holder.refresh('notice');
    const second = holder.refresh('notice');
    expect(read).toHaveBeenCalledTimes(1);
    answers[0](values(30, 90));
    await demand;
    await Promise.resolve();
    // The notices' read starts only now, after the running one - and both notices share it.
    expect(read).toHaveBeenCalledTimes(2);
    answers[1](values(7, 90));
    await expect(notice).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(holder.require()).toEqual(values(7, 90));
  });

  it('one read at a time: a demand arriving as the running read hands over joins, never starts a second', async () => {
    let running = 0;
    let most = 0;
    const answers: Array<(v: MediaRetentionDays) => void> = [];
    const read = jest.fn(
      () =>
        new Promise<MediaRetentionDays>((resolve) => {
          running += 1;
          most = Math.max(most, running);
          answers.push((v) => {
            running -= 1;
            resolve(v);
          });
        })
    );
    const holder = new MediaRetentionHolder(read, logs());

    void holder.refresh('demand');
    const notice = holder.refresh('notice');
    answers[0](values(30, 90));
    // Every microtask of the hand-over, a demand: none may start a read of its own.
    for (let i = 0; i < 6; i++) {
      void holder.refresh('demand');
      await Promise.resolve();
    }
    expect(read).toHaveBeenCalledTimes(2);
    answers[1](values(7, 90));
    await expect(notice).resolves.toBe(true);
    expect(most).toBe(1);
    expect(holder.require()).toEqual(values(7, 90));
  });

  it('a read that rejects still hands over: the queued notice is never left pending', async () => {
    const answers: Array<{ ok: (v: MediaRetentionDays) => void; ko: (e: unknown) => void }> = [];
    const read = jest.fn(
      () => new Promise<MediaRetentionDays>((ok, ko) => answers.push({ ok, ko }))
    );
    const logger = logs();
    const holder = new MediaRetentionHolder(read, logger);
    // Make the FIRST read's own handling reject, as a defect would.
    const readOnce = jest
      .spyOn(holder as unknown as { readOnce: () => Promise<boolean> }, 'readOnce')
      .mockImplementationOnce(() => Promise.reject(new Error('defect')));

    const first = holder.refresh('demand');
    const notice = holder.refresh('notice');
    await expect(first).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('REJECTED'));
    readOnce.mockRestore();
    await Promise.resolve();
    answers[0].ok(values(7, 90));
    await expect(notice).resolves.toBe(true);
  });

  it('a refusal before any read is not counted into a later outage', async () => {
    let now = 1_000_000;
    const read = jest
      .fn<Promise<MediaRetentionDays>, []>()
      .mockResolvedValueOnce(values(30, 90))
      .mockRejectedValueOnce(new ServiceUnavailableException('social-service unreachable'))
      .mockResolvedValue(values(30, 90));
    const logger = logs();
    const holder = new MediaRetentionHolder(read, logger, () => now);

    expect(() => holder.require()).toThrow(ServiceUnavailableException);
    await holder.refresh('demand');

    await holder.refresh('notice'); // fails: an outage opens, with values held
    now += 10_000;
    await holder.refresh('notice'); // succeeds: it closes
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('after 10 s: 0 upload(s) refused meanwhile')
    );
  });

  it('applies a changed value from the notice on', async () => {
    const read = jest
      .fn<Promise<MediaRetentionDays>, []>()
      .mockResolvedValueOnce(values(30, 90))
      .mockResolvedValueOnce(values(7, 90));
    const holder = new MediaRetentionHolder(read, logs());
    await holder.refresh('boot');
    expect(holder.require().chatReelDays).toBe(30);
    await holder.refresh('notice');
    expect(holder.require().chatReelDays).toBe(7);
  });

  it('shares one read between the uploads that ask for one while it runs', async () => {
    let resolve!: (v: MediaRetentionDays) => void;
    const read = jest.fn(() => new Promise<MediaRetentionDays>((r) => (resolve = r)));
    const holder = new MediaRetentionHolder(read, logs());
    const a = holder.refresh('demand');
    const b = holder.refresh('demand');
    resolve(values(30, 90));
    await Promise.all([a, b]);
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe('an upload reads the HELD durations, never the network', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('social-service down after the boot read: a chat upload is still stamped with the last value', async () => {
    jest.restoreAllMocks();
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ chatReelDays: 9, idleFileDays: 45 }), { status: 200 })
      )
    ) as typeof fetch;
    await mediaRetention.refresh('boot');
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;

    const items: Record<string, Entry> = {};
    const { service } = serviceWith(items);
    const id = await service.upload(Buffer.alloc(10), 'alice', 'chat-reel');
    const hold = items[id].holds?.chat;
    expect(hold!.dueAt - hold!.heldAt).toBe(9 * DAY);
    const file = await service.upload(Buffer.alloc(10), 'alice', 'ephemeral');
    expect(items[file].idleRetentionMs).toBe(45 * DAY);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('an admin change, once noticed, applies to the next upload', async () => {
    jest.restoreAllMocks();
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ chatReelDays: 3, idleFileDays: 45 }), { status: 200 })
      )
    ) as typeof fetch;
    await mediaRetention.refresh('notice');

    const items: Record<string, Entry> = {};
    const { service } = serviceWith(items);
    const id = await service.upload(Buffer.alloc(10), 'alice', 'chat-reel');
    const hold = items[id].holds?.chat;
    expect(hold!.dueAt - hold!.heldAt).toBe(3 * DAY);
  });
});

describe('RetentionBootstrap - the boot read is awaited before the routes listen', () => {
  it('resolves only once the boot read has settled, so an upload never meets a read still running', async () => {
    let settle!: (ok: boolean) => void;
    const refresh = jest
      .spyOn(mediaRetention, 'refresh')
      .mockImplementation(() => new Promise<boolean>((r) => (settle = r)));
    let done = false;
    const boot = new RetentionBootstrap().onApplicationBootstrap().then(() => (done = true));
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledWith('boot');
    expect(done).toBe(false);
    settle(false);
    await boot;
    expect(done).toBe(true);
    refresh.mockRestore();
  });
});
