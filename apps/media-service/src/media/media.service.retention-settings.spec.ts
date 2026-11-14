/**
 * THE ADMIN RETENTION DURATIONS, STAMPED AT CREATION (owner, 2026-11-14; docs/wiki/retention-settings.md).
 *
 * Pinned, each because the opposite is a plausible mistake:
 *  - an `ephemeral` upload carries the idle window IN FORCE at its upload, and the sweep reads it -
 *    a window read at the sweep would apply a lowered duration to every file already stored;
 *  - a file uploaded before the setting keeps the 90 days it was promised;
 *  - a `chat-reel` upload is due one window (in force) after its upload, written as its hold;
 *  - a duration that cannot be read REFUSES the upload with nothing stored - never a default.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { MediaService } from './media.service';
import { fetchMediaRetention } from './retention-settings';

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

const answer = (chatReelDays: number, idleMediaDays: number) =>
  jest.spyOn(MediaService.prototype, 'readRetention').mockResolvedValue({
    chatReelDays,
    idleMediaDays,
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
    jest
      .spyOn(MediaService.prototype, 'readRetention')
      .mockRejectedValue(new ServiceUnavailableException());
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
  const logger = { warn: jest.fn() } as never;
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
    relayAnswers(200, { chatReelDays: 14, idleMediaDays: 60, reelDays: 365 });
    await expect(fetchMediaRetention(logger)).resolves.toEqual({
      chatReelDays: 14,
      idleMediaDays: 60,
    });
  });

  it('answers 503 on a refusal or an unreachable relay', async () => {
    relayAnswers(500, {});
    await expect(fetchMediaRetention(logger)).rejects.toBeInstanceOf(ServiceUnavailableException);
    global.fetch = jest.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    await expect(fetchMediaRetention(logger)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it.each([0, 1.5, '30', null])('THROWS on an unusable value %p, never a default', async (bad) => {
    relayAnswers(200, { chatReelDays: bad, idleMediaDays: 90 });
    await expect(fetchMediaRetention(logger)).rejects.toThrow(/chatReelDays/);
  });
});
