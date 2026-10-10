/**
 * The `chat-reel` class: a CanaReel SENT IN A CONVERSATION (docs/wiki/frontend/modules/reels-in-chat.md).
 *
 * Four things are pinned, each because the opposite is a plausible mistake:
 *  - it is swept by AGE from upload, NOT by idleness - `lastAccessAt` moves on every read, so an
 *    idle clock would let a reel watched every 29 days live for ever, against the promise shown to
 *    the sender;
 *  - the sweep is still an ALLOWLIST - adding a class must not make `reel`, `archive`,
 *    `association`, an unclassified or a public object sweepable by omission;
 *  - the sender's delete is an OWNERSHIP allowlist (the class AND the owner), so it cannot be aimed
 *    at a feed photo, a vault document or somebody else's reel;
 *  - the per-member daily budget is counted from live entries and refused as a 429.
 */
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { MediaService, isRetentionClass } from './media.service';

const UUID_REEL_OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_REEL_NEW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_FEED_REEL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const UUID_ARCHIVE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const UUID_DOCUMENT = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const UUID_CHAT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const UUID_UNCLASSIFIED = '11111111-2222-4333-8444-555555555555';
const UUID_LOGO = '66666666-7777-4888-8999-aaaaaaaaaaaa';

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: string;
  publicAsset?: boolean;
  retentionClass?: string;
  ownerId?: string;
  contentType?: string;
  size?: number;
};

type ServiceInternals = {
  meta: { items: Record<string, Entry> };
  storage: Record<string, unknown>;
  logger: {
    log: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  sweepIntervalMs: number;
  uploadLocks: Map<string, Promise<void>>;
};

const DAY = 24 * 60 * 60 * 1000;
/** Older than the 30-day window and than the 90-day idle window alike. */
const LONG_AGO = Date.now() - 400 * DAY;

function streamOf(bytes: Buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

/** A service with planted metadata, a recording storage stub and persistence disabled. */
function serviceWith(items: Record<string, Entry>, failDeleteOf: string[] = []) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const put: Array<{ id: string; bytes: number }> = [];
  const failPut = { value: false };
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      if (failDeleteOf.includes(id)) return Promise.reject(new Error('store refused'));
      deleted.push(id);
      return Promise.resolve();
    },
    get: (id: string) =>
      Promise.resolve(
        id in items && !deleted.includes(id) ? streamOf(Buffer.from('ciphertext')) : null
      ),
    // Yields to the event loop first: the real store write is an await, and THAT gap is the one a
    // concurrent upload slips through when the budget is checked but not reserved.
    put: async (id: string, _data: Buffer, size: number) => {
      await new Promise((resolve) => setImmediate(resolve));
      if (failPut.value) throw new Error('store down');
      put.push({ id, bytes: size });
    },
    putFileStream: async (id: string, _file: string, size: number) => {
      await new Promise((resolve) => setImmediate(resolve));
      put.push({ id, bytes: size });
    },
    listObjects: () =>
      Promise.resolve(
        Object.keys(items)
          .filter((id) => !deleted.includes(id))
          .map((id) => ({ id, size: 10, lastModifiedMs: Date.now() }))
      ),
  };
  internals.logger = { log: () => {}, warn: () => {}, error: () => {} };
  internals.uploadLocks = new Map();
  internals.persistMetadata = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, deleted, put, failPut };
}

const purge = (service: MediaService) =>
  (service as unknown as ServiceInternals).purgeExpiredMedia();

describe('chat-reel: a class a client may name', () => {
  it('is a recognised retention class', () => {
    expect(isRetentionClass('chat-reel')).toBe(true);
    expect(isRetentionClass('chat_reel')).toBe(false);
  });
});

describe('chat-reel: swept by AGE from upload, never by idleness', () => {
  it('takes a reel older than 30 days EVEN THOUGH it was read a minute ago', async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_OLD]: {
        createdAt: Date.now() - 31 * DAY,
        lastAccessAt: Date.now() - 60_000,
        retentionClass: 'chat-reel',
        ownerId: 'sender',
      },
    };
    const { service, deleted } = serviceWith(items);

    await purge(service);

    expect(deleted).toEqual([UUID_REEL_OLD]);
    expect(items[UUID_REEL_OLD].purgeReason).toBe('reel_expired');
  });

  it('leaves a reel inside its 30 days alone, however long nobody opened it', async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_NEW]: {
        createdAt: Date.now() - 29 * DAY,
        // Idle for longer than the 90-day chat window: an idle clock would take it. Age must not.
        lastAccessAt: LONG_AGO,
        retentionClass: 'chat-reel',
        ownerId: 'sender',
      },
    };
    const { service, deleted } = serviceWith(items);

    await purge(service);

    expect(deleted).toEqual([]);
    expect(items[UUID_REEL_NEW].purgedAt).toBeUndefined();
  });

  it('answers 410 (a `purged` download) for a reel it swept, never a 404', async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_OLD]: {
        createdAt: Date.now() - 31 * DAY,
        lastAccessAt: Date.now(),
        retentionClass: 'chat-reel',
        ownerId: 'sender',
      },
    };
    const { service } = serviceWith(items);

    // `download()` runs the sweep first: this is the real path a late viewer takes.
    expect((await service.download(UUID_REEL_OLD)).status).toBe('purged');
    expect((await service.downloadRange(UUID_REEL_OLD, 'bytes=0-9')).status).toBe('purged');
  });
});

describe('chat-reel: the sweep is still an ALLOWLIST', () => {
  it('takes an overdue chat-reel and an idle ephemeral object, and NOTHING else', async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_OLD]: {
        createdAt: LONG_AGO,
        lastAccessAt: Date.now(),
        retentionClass: 'chat-reel',
      },
      [UUID_CHAT]: { createdAt: LONG_AGO, lastAccessAt: LONG_AGO, retentionClass: 'ephemeral' },
      // The published reel: ended by its post through social-service, never by this sweep.
      [UUID_FEED_REEL]: { createdAt: LONG_AGO, lastAccessAt: LONG_AGO, retentionClass: 'reel' },
      [UUID_ARCHIVE]: { createdAt: LONG_AGO, lastAccessAt: LONG_AGO, retentionClass: 'archive' },
      [UUID_DOCUMENT]: {
        createdAt: LONG_AGO,
        lastAccessAt: LONG_AGO,
        retentionClass: 'association',
      },
      [UUID_UNCLASSIFIED]: { createdAt: LONG_AGO, lastAccessAt: LONG_AGO },
      [UUID_LOGO]: {
        createdAt: LONG_AGO,
        lastAccessAt: LONG_AGO,
        retentionClass: 'chat-reel',
        publicAsset: true,
        contentType: 'image/webp',
      },
    };
    const { service, deleted } = serviceWith(items);

    await purge(service);

    expect(deleted.sort()).toEqual([UUID_CHAT, UUID_REEL_OLD].sort());
    for (const kept of [
      UUID_FEED_REEL,
      UUID_ARCHIVE,
      UUID_DOCUMENT,
      UUID_UNCLASSIFIED,
      UUID_LOGO,
    ]) {
      expect(items[kept].purgedAt).toBeUndefined();
    }
    // Each reason names its own cause.
    expect(items[UUID_CHAT].purgeReason).toBe('retention_expired');
    expect(items[UUID_REEL_OLD].purgeReason).toBe('reel_expired');
  });
});

describe("chat-reel: the stats name it, and its overdue figure is the sweep's own verdict", () => {
  it('counts live chat-reels on their own line, overdue ones apart, and never as ephemeral', async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_OLD]: {
        createdAt: LONG_AGO,
        lastAccessAt: Date.now(),
        retentionClass: 'chat-reel',
      },
      [UUID_REEL_NEW]: {
        createdAt: Date.now() - DAY,
        lastAccessAt: Date.now(),
        retentionClass: 'chat-reel',
      },
      [UUID_CHAT]: { createdAt: LONG_AGO, lastAccessAt: LONG_AGO, retentionClass: 'ephemeral' },
    };
    const { service } = serviceWith(items);

    const stats = await service.getStorageStats();

    expect(stats.chatReelCount).toBe(2);
    expect(stats.chatReelBytes).toBe(20);
    expect(stats.chatReelOverdueCount).toBe(1);
    expect(stats.chatReelOverdueBytes).toBe(10);
    expect(stats.chatReelRetentionMs).toBe(30 * DAY);
    // The ephemeral object is still the ONLY idle-window verdict.
    expect(stats.overdueCount).toBe(1);
  });
});

describe("chat-reel: the sender's delete is an OWNERSHIP allowlist", () => {
  const reel = (ownerId: string | undefined, retentionClass = 'chat-reel'): Entry => ({
    createdAt: Date.now(),
    lastAccessAt: Date.now(),
    retentionClass,
    ownerId,
  });

  it("deletes the sender's own chat-reel and tombstones it so the next read is a 410", async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: reel('sender') };
    const { service, deleted } = serviceWith(items);

    expect(await service.removeChatReel(UUID_REEL_NEW, 'sender')).toBe('deleted');

    expect(deleted).toEqual([UUID_REEL_NEW]);
    expect(items[UUID_REEL_NEW].purgeReason).toBe('reel_deleted');
    expect((await service.download(UUID_REEL_NEW)).status).toBe('purged');
  });

  it("REFUSES somebody else's chat-reel - citing an id is not owning it", async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: reel('sender') };
    const { service, deleted } = serviceWith(items);

    expect(await service.removeChatReel(UUID_REEL_NEW, 'intruder')).toBe('refused');
    expect(await service.removeChatReel(UUID_REEL_NEW, '')).toBe('refused');
    expect(deleted).toEqual([]);
    expect(items[UUID_REEL_NEW].purgedAt).toBeUndefined();
  });

  it("REFUSES the caller's OWN object when it is not a chat-reel (a feed photo, a vault document, a feed reel, an unclassified blob)", async () => {
    const items: Record<string, Entry> = {
      [UUID_ARCHIVE]: reel('sender', 'archive'),
      [UUID_DOCUMENT]: reel('sender', 'association'),
      [UUID_FEED_REEL]: reel('sender', 'reel'),
      [UUID_CHAT]: reel('sender', 'ephemeral'),
      [UUID_UNCLASSIFIED]: { createdAt: 1, lastAccessAt: 1, ownerId: 'sender' },
    };
    const { service, deleted } = serviceWith(items);

    for (const id of Object.keys(items)) {
      expect(await service.removeChatReel(id, 'sender')).toBe('refused');
    }
    expect(deleted).toEqual([]);
  });

  it('refuses an object stored before ownership was recorded rather than trusting the caller', async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: reel(undefined) };
    const { service, deleted } = serviceWith(items);

    expect(await service.removeChatReel(UUID_REEL_NEW, 'sender')).toBe('refused');
    expect(deleted).toEqual([]);
  });

  it('is idempotent: an unknown or already purged id is `absent`, success for a retry', async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_OLD]: { ...reel('sender'), purgedAt: Date.now(), purgeReason: 'reel_expired' },
    };
    const { service } = serviceWith(items);

    expect(await service.removeChatReel(UUID_REEL_OLD, 'sender')).toBe('absent');
    expect(await service.removeChatReel(UUID_LOGO, 'sender')).toBe('absent');
  });

  it('keeps the entry when the store refuses, so the delete can be retried', async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: reel('sender') };
    const { service } = serviceWith(items, [UUID_REEL_NEW]);

    expect(await service.removeChatReel(UUID_REEL_NEW, 'sender')).toBe('failed');
    expect(items[UUID_REEL_NEW].purgedAt).toBeUndefined();
  });

  it('rejects an id that is not a UUID before touching the index', async () => {
    const { service } = serviceWith({});
    await expect(service.removeChatReel('__proto__', 'sender')).rejects.toThrow('Invalid mediaId');
  });
});

describe('chat-reel: account deletion reaches it', () => {
  it("takes a departing member's chat-reel like any of their uploads", async () => {
    const items: Record<string, Entry> = {
      [UUID_REEL_NEW]: {
        createdAt: Date.now(),
        lastAccessAt: Date.now(),
        retentionClass: 'chat-reel',
        ownerId: 'departing',
      },
    };
    const { service, deleted } = serviceWith(items);

    expect(await service.removeAllOwnedBy('departing')).toEqual({ deleted: 1, failed: 0 });
    expect(deleted).toEqual([UUID_REEL_NEW]);
  });
});

describe('chat-reel: the per-member daily budget (500 MB)', () => {
  const MB = 1024 * 1024;
  const live = (ownerId: string, sizeMb: number, ageMs = 60_000): Entry => ({
    createdAt: Date.now() - ageMs,
    lastAccessAt: Date.now(),
    retentionClass: 'chat-reel',
    ownerId,
    size: sizeMb * MB,
  });

  it('accepts an upload that stays under the budget and records its size', async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: live('sender', 300) };
    const { service, put } = serviceWith(items);

    const id = await service.upload(Buffer.alloc(100), 'sender', 'chat-reel');

    expect(put).toEqual([{ id, bytes: 100 }]);
    expect(items[id].size).toBe(100);
    expect(items[id].retentionClass).toBe('chat-reel');
  });

  it('refuses with a 429 an upload that would cross it, and stores nothing', async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: live('sender', 499) };
    const { service, put } = serviceWith(items);

    const refused = service.upload(Buffer.alloc(2 * MB), 'sender', 'chat-reel');

    await expect(refused).rejects.toBeInstanceOf(HttpException);
    await expect(refused).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(put).toEqual([]);
  });

  it("counts only the CALLER's live chat-reels of the last 24 hours", async () => {
    const items: Record<string, Entry> = {
      // Somebody else's 499 MB, and the caller's own from two days ago, and a swept one: none count.
      [UUID_REEL_NEW]: live('someone-else', 499),
      [UUID_REEL_OLD]: live('sender', 499, 2 * DAY),
      [UUID_FEED_REEL]: {
        ...live('sender', 499),
        purgedAt: Date.now(),
        purgeReason: 'reel_deleted',
      },
    };
    const { service, put } = serviceWith(items);

    await service.upload(Buffer.alloc(400 * MB), 'sender', 'chat-reel');

    expect(put).toHaveLength(1);
  });

  it('does not meter anything that is not a chat-reel', async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: live('sender', 499) };
    const { service, put } = serviceWith(items);

    await service.upload(Buffer.alloc(2 * MB), 'sender', 'ephemeral');
    await service.upload(Buffer.alloc(2 * MB), 'sender', undefined);

    expect(put).toHaveLength(2);
  });
});

describe('chat-reel: the budget is RESERVED, not just checked', () => {
  const MB = 1024 * 1024;
  const planted = (mb: number): Entry => ({
    createdAt: Date.now() - 60_000,
    lastAccessAt: Date.now(),
    retentionClass: 'chat-reel',
    ownerId: 'sender',
    size: mb * MB,
  });

  it('lets exactly the uploads that fit through when they run CONCURRENTLY', async () => {
    // 498 MB used: two more 1 MB reels fit (500), the third must not. Checked then registered across
    // an await, all three used to read 498 and all three passed.
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: planted(498) };
    const { service, put } = serviceWith(items);

    const results = await Promise.allSettled([
      service.upload(Buffer.alloc(MB), 'sender', 'chat-reel'),
      service.upload(Buffer.alloc(MB), 'sender', 'chat-reel'),
      service.upload(Buffer.alloc(MB), 'sender', 'chat-reel'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(put).toHaveLength(2);
  });

  it('rolls the reservation back when the store write fails, so the bytes are not lost to the member', async () => {
    const items: Record<string, Entry> = { [UUID_REEL_NEW]: planted(498) };
    const { service, put, failPut } = serviceWith(items);

    failPut.value = true;
    await expect(service.upload(Buffer.alloc(2 * MB), 'sender', 'chat-reel')).rejects.toThrow(
      'store down'
    );
    failPut.value = false;
    await service.upload(Buffer.alloc(2 * MB), 'sender', 'chat-reel');

    expect(put).toHaveLength(1);
  });

  it('REFUSES (and logs) a chat-reel with no owner instead of skipping the cap', async () => {
    const { service, put } = serviceWith({});
    const errors: string[] = [];
    (service as unknown as ServiceInternals).logger.error = (m) => errors.push(m);

    await expect(service.upload(Buffer.alloc(10), undefined, 'chat-reel')).rejects.toBeInstanceOf(
      InternalServerErrorException
    );

    expect(put).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe('chat-reel: a chunked upload reserves its declared total at INIT', () => {
  const MB = 1024 * 1024;
  const planted = (mb: number): Entry => ({
    createdAt: Date.now() - 60_000,
    lastAccessAt: Date.now(),
    retentionClass: 'chat-reel',
    ownerId: 'sender',
    size: mb * MB,
  });
  const CAP = 100 * MB;

  it('refuses at init, before staging a byte, when the declared total is over budget', async () => {
    const { service } = serviceWith({ [UUID_REEL_NEW]: planted(499) });

    const refused = service.initChunkedUpload('sender', 'chat-reel', 2 * MB, CAP);

    await expect(refused).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('requires a chat-reel to declare its total, and honours the size policy', async () => {
    const { service } = serviceWith({});

    await expect(service.initChunkedUpload('sender', 'chat-reel', undefined, CAP)).rejects.toThrow(
      BadRequestException
    );
    await expect(
      service.initChunkedUpload('sender', 'chat-reel', CAP + 1, CAP)
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('holds the reservation against a concurrent init, and gives it back when the session ends', async () => {
    const { service } = serviceWith({ [UUID_REEL_NEW]: planted(300) });

    const first = await service.initChunkedUpload('sender', 'chat-reel', 150 * MB, 200 * MB);
    // 300 + 150 reserved: a second 100 MB session does not fit...
    await expect(
      service.initChunkedUpload('sender', 'chat-reel', 100 * MB, 200 * MB)
    ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });

    // ...completing the first frees its reservation, and the finished entry counts as 10 bytes.
    await service.appendChunk(first, Buffer.alloc(10), 200 * MB, 'sender');
    const mediaId = await service.completeChunkedUpload(first, 200 * MB, 'sender', 'chat-reel');
    expect(mediaId).toMatch(/^[0-9a-f-]{36}$/);
    const second = await service.initChunkedUpload('sender', 'chat-reel', 100 * MB, 200 * MB);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    await service.completeChunkedUpload(second, 200 * MB, 'sender', undefined).catch(() => {});
  });

  it('refuses a chunk past the declared total and releases the session', async () => {
    const { service } = serviceWith({ [UUID_REEL_NEW]: planted(490) });

    const id = await service.initChunkedUpload('sender', 'chat-reel', 5 * MB, 200 * MB);
    await expect(
      service.appendChunk(id, Buffer.alloc(6 * MB), 200 * MB, 'sender')
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    // Its 5 MB went back: 490 + 10 fits.
    const next = await service.initChunkedUpload('sender', 'chat-reel', 10 * MB, 200 * MB);
    expect(next).toBeTruthy();
    await service.completeChunkedUpload(next, 200 * MB, 'sender', undefined).catch(() => {});
  });

  it('refuses completion by a member other than the one who opened the session', async () => {
    const { service } = serviceWith({});

    const id = await service.initChunkedUpload('sender', 'chat-reel', MB, 200 * MB);

    await expect(
      service.completeChunkedUpload(id, 200 * MB, 'intruder', 'chat-reel')
    ).rejects.toThrow('Not your upload session');
    await service.completeChunkedUpload(id, 200 * MB, 'sender', undefined).catch(() => {});
  });
});
