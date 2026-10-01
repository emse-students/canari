/**
 * The retention classes - what the idle sweep may take, and what each class keeps from erasure.
 *
 * THE SWEEP IS AN ALLOWLIST, and the cases below are built to fail if it ever becomes a denylist
 * again. Until 2026-10-01 it deleted every idle object that no exemption named, and an
 * association's vault document - uploaded with no class, because nobody had thought of it - was
 * swept on production: the row stayed, the vault key answered, and the download answered 410.
 * So the load-bearing assertions are the ones about objects NOBODY classified: an unclassified
 * entry, an unknown class name, an entry re-created after an index loss - all of them are kept.
 *
 * The other weight is `removeAllOwnedBy`: exemption from the idle sweep is not exemption from
 * erasure. An archived post photo goes with its uploader's account; a vault document does not,
 * because it belongs to the association.
 */
import { MediaService, isRetentionClass } from './media.service';

const UUID_CHAT = '11111111-1111-4111-8111-111111111111';
const UUID_ARCHIVE = '22222222-2222-4222-8222-222222222222';
const UUID_PURGED = '33333333-3333-4333-8333-333333333333';
const UUID_UNKNOWN = '44444444-4444-4444-8444-444444444444';
const UUID_DOCUMENT = '55555555-5555-4555-8555-555555555555';
const UUID_UNCLASSIFIED = '66666666-6666-4666-8666-666666666666';
const UUID_LOGO = '77777777-7777-4777-8777-777777777777';

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: string;
  publicAsset?: boolean;
  retentionClass?: string;
  ownerId?: string;
  contentType?: string;
};

type ServiceInternals = {
  meta: { items: Record<string, Entry> };
  storage: {
    delete: (id: string) => Promise<void>;
    get: (id: string) => Promise<unknown>;
    listObjects: () => Promise<Array<{ id: string; size: number; lastModifiedMs: number | null }>>;
  };
  logger: { log: (msg: string) => void; warn: (msg: string) => void };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  sweepIntervalMs: number;
};

/** A readable stream of `bytes`, which is all `readStreamToBuffer` asks of storage. */
function streamOf(bytes: Buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

/**
 * A service with planted metadata, a recording storage stub and persistence disabled. Storage
 * holds every planted id until the service deletes it, so a download after a sweep reads what the
 * sweep actually left.
 */
function serviceWith(items: Record<string, Entry>): {
  service: MediaService;
  deleted: string[];
} {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      deleted.push(id);
      return Promise.resolve();
    },
    get: (id: string) =>
      Promise.resolve(
        id in items && !deleted.includes(id) ? streamOf(Buffer.from('ciphertext')) : null
      ),
    listObjects: () =>
      Promise.resolve(
        Object.keys(items)
          .filter((id) => !deleted.includes(id))
          .map((id) => ({ id, size: 10, lastModifiedMs: Date.now() }))
      ),
  };
  // The constructor is bypassed, so the Logger it would have built is not there. Silent rather
  // than piped to the console: a spec that prints teaches its reader to skip the line that matters.
  internals.logger = { log: () => {}, warn: () => {} };
  internals.persistMetadata = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, deleted };
}

/** Older than any retention window this service will ever be configured with. */
const LONG_IDLE = Date.now() - 400 * 24 * 60 * 60 * 1000;

const idle = (extra: Partial<Entry> = {}): Entry => ({
  createdAt: LONG_IDLE,
  lastAccessAt: LONG_IDLE,
  ...extra,
});

describe('retention class: the idle sweep is an ALLOWLIST', () => {
  it('takes an idle ephemeral object and NOTHING else', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: idle({ retentionClass: 'ephemeral' }),
      [UUID_ARCHIVE]: idle({ retentionClass: 'archive' }),
      [UUID_DOCUMENT]: idle({ retentionClass: 'association' }),
      [UUID_UNCLASSIFIED]: idle(),
      // A class this build has never heard of: written by a future version, or by hand.
      [UUID_UNKNOWN]: idle({ retentionClass: 'something-new' }),
      [UUID_LOGO]: idle({ publicAsset: true, contentType: 'image/webp' }),
    };
    const { service, deleted } = serviceWith(items);

    await (service as unknown as ServiceInternals).purgeExpiredMedia();

    expect(deleted).toEqual([UUID_CHAT]);
    expect(items[UUID_CHAT].purgeReason).toBe('retention_expired');
    for (const kept of [UUID_ARCHIVE, UUID_DOCUMENT, UUID_UNCLASSIFIED, UUID_UNKNOWN, UUID_LOGO]) {
      expect(items[kept].purgedAt).toBeUndefined();
    }
    // The class is still on what was kept.
    expect(items[UUID_DOCUMENT].retentionClass).toBe('association');
  });

  it('leaves an ephemeral object inside the window alone', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: { createdAt: LONG_IDLE, lastAccessAt: Date.now(), retentionClass: 'ephemeral' },
    };
    const { service, deleted } = serviceWith(items);

    await (service as unknown as ServiceInternals).purgeExpiredMedia();

    expect(deleted).toEqual([]);
  });

  it('never answers `purged` for an association document, however long it sat unopened', async () => {
    // The production failure end to end: an idle vault document, then a download. `download()`
    // runs the sweep itself first, so this is the real path the 410 took.
    const items: Record<string, Entry> = {
      [UUID_DOCUMENT]: idle({ retentionClass: 'association', ownerId: 'officer' }),
    };
    const { service, deleted } = serviceWith(items);

    const result = await service.download(UUID_DOCUMENT);

    expect(result.status).toBe('ok');
    expect(deleted).toEqual([]);
    expect(items[UUID_DOCUMENT].purgedAt).toBeUndefined();
    // The read refreshed the clock and kept the class.
    expect(items[UUID_DOCUMENT].retentionClass).toBe('association');
    expect(items[UUID_DOCUMENT].lastAccessAt).toBeGreaterThan(LONG_IDLE);
  });

  it('never answers `purged` for an UNCLASSIFIED object either - a forgotten class is kept', async () => {
    const items: Record<string, Entry> = { [UUID_UNCLASSIFIED]: idle() };
    const { service } = serviceWith(items);

    expect((await service.download(UUID_UNCLASSIFIED)).status).toBe('ok');
  });

  it('counts kept objects on their own lines, never as overdue', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: idle({ retentionClass: 'ephemeral' }),
      [UUID_ARCHIVE]: idle({ retentionClass: 'archive' }),
      [UUID_DOCUMENT]: idle({ retentionClass: 'association' }),
      [UUID_UNCLASSIFIED]: idle(),
    };
    const { service } = serviceWith(items);

    const stats = await service.getStorageStats();

    // Only the ephemeral object is a verdict on the sweep.
    expect(stats.overdueCount).toBe(1);
    expect(stats.archiveCount).toBe(1);
    expect(stats.associationCount).toBe(1);
    expect(stats.unclassifiedCount).toBe(1);
  });
});

describe('retention class: account deletion', () => {
  it('REACHES an archived object - a post photo goes with the account that uploaded it', async () => {
    const items: Record<string, Entry> = {
      [UUID_ARCHIVE]: {
        createdAt: LONG_IDLE,
        lastAccessAt: Date.now(),
        retentionClass: 'archive',
        ownerId: 'departing-member',
      },
    };
    const { service, deleted } = serviceWith(items);

    const result = await service.removeAllOwnedBy('departing-member');

    expect(result).toEqual({ deleted: 1, failed: 0 });
    expect(deleted).toEqual([UUID_ARCHIVE]);
    expect(items[UUID_ARCHIVE].purgeReason).toBe('manual_delete');
  });

  it('SKIPS an association document - the vault outlives the officer who uploaded to it', async () => {
    const items: Record<string, Entry> = {
      [UUID_DOCUMENT]: {
        createdAt: LONG_IDLE,
        lastAccessAt: Date.now(),
        retentionClass: 'association',
        ownerId: 'departing-member',
      },
    };
    const { service, deleted } = serviceWith(items);

    expect(await service.removeAllOwnedBy('departing-member')).toEqual({ deleted: 0, failed: 0 });
    expect(deleted).toEqual([]);
  });

  it('still SKIPS a public asset - a logo outlives the member who uploaded it', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: {
        createdAt: LONG_IDLE,
        lastAccessAt: Date.now(),
        publicAsset: true,
        contentType: 'image/webp',
        ownerId: 'departing-member',
      },
    };
    const { service, deleted } = serviceWith(items);

    expect(await service.removeAllOwnedBy('departing-member')).toEqual({ deleted: 0, failed: 0 });
    expect(deleted).toEqual([]);
  });
});

describe('MediaService.remove', () => {
  it('keeps the tombstone of an object the sweep already took', async () => {
    // A member who meets the loss deletes the dead row; that must not rewrite WHY it was gone.
    const items: Record<string, Entry> = {
      [UUID_PURGED]: idle({ purgedAt: 1234, purgeReason: 'retention_expired' }),
    };
    const { service } = serviceWith(items);

    await service.remove(UUID_PURGED);

    expect(items[UUID_PURGED].purgedAt).toBe(1234);
    expect(items[UUID_PURGED].purgeReason).toBe('retention_expired');
  });

  it('tombstones a live object as a manual delete', async () => {
    const items: Record<string, Entry> = {
      [UUID_DOCUMENT]: idle({ retentionClass: 'association' }),
    };
    const { service, deleted } = serviceWith(items);

    await service.remove(UUID_DOCUMENT);

    expect(deleted).toEqual([UUID_DOCUMENT]);
    expect(items[UUID_DOCUMENT].purgeReason).toBe('manual_delete');
  });
});

describe('isRetentionClass', () => {
  it('accepts the three classes and nothing else', () => {
    expect(isRetentionClass('ephemeral')).toBe(true);
    expect(isRetentionClass('archive')).toBe(true);
    expect(isRetentionClass('association')).toBe(true);
    expect(isRetentionClass(null)).toBe(false);
    expect(isRetentionClass(undefined)).toBe(false);
    expect(isRetentionClass('__proto__')).toBe(false);
  });
});

describe('MediaService.setRetentionClass', () => {
  it('classifies live entries and reports how many actually changed', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: { createdAt: 1, lastAccessAt: 1 },
      [UUID_ARCHIVE]: { createdAt: 1, lastAccessAt: 1, retentionClass: 'archive' },
    };
    const { service } = serviceWith(items);

    // Only the unclassified one is a change; re-applying a class it already holds is not.
    expect(await service.setRetentionClass([UUID_CHAT, UUID_ARCHIVE], 'archive')).toBe(1);
    expect(items[UUID_CHAT].retentionClass).toBe('archive');
  });

  it('releases an archived entry onto the idle window, which then sweeps it', async () => {
    const items: Record<string, Entry> = { [UUID_ARCHIVE]: idle({ retentionClass: 'archive' }) };
    const { service, deleted } = serviceWith(items);

    expect(await service.setRetentionClass([UUID_ARCHIVE], 'ephemeral')).toBe(1);
    expect(items[UUID_ARCHIVE].retentionClass).toBe('ephemeral');

    // The release is not a delete: the object goes when the ordinary clock says so, not before.
    expect(deleted).toEqual([]);
    await (service as unknown as ServiceInternals).purgeExpiredMedia();
    expect(deleted).toEqual([UUID_ARCHIVE]);
  });

  it('never makes a public asset sweepable', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: idle({ publicAsset: true, contentType: 'image/webp' }),
    };
    const { service, deleted } = serviceWith(items);

    expect(await service.setRetentionClass([UUID_CHAT], 'ephemeral')).toBe(0);
    await (service as unknown as ServiceInternals).purgeExpiredMedia();
    expect(deleted).toEqual([]);
  });

  it('never revives a tombstone and never invents an entry', async () => {
    const items: Record<string, Entry> = {
      [UUID_PURGED]: {
        createdAt: 1,
        lastAccessAt: 1,
        purgedAt: 2,
        purgeReason: 'retention_expired',
      },
    };
    const { service } = serviceWith(items);

    // A row legitimately cites an object swept before any of this existed. Classifying it would
    // resurrect an entry the retention decision already closed.
    expect(await service.setRetentionClass([UUID_PURGED, UUID_UNKNOWN], 'association')).toBe(0);
    expect(items[UUID_PURGED].retentionClass).toBeUndefined();
    expect(items[UUID_UNKNOWN]).toBeUndefined();
  });

  it('ignores ids that are not UUIDs rather than writing them into the index', async () => {
    const items: Record<string, Entry> = {};
    const { service } = serviceWith(items);

    expect(await service.setRetentionClass(['__proto__', '../etc/passwd'], 'archive')).toBe(0);
    expect(Object.keys(items)).toEqual([]);
  });
});
