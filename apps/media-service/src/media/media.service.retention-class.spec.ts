/**
 * The `archive` retention class - what it exempts an object from, and what it deliberately does not.
 *
 * The class exists because the service holds ciphertext and cannot tell a post photo from a chat
 * photo, so it deleted both on the same idle clock: on 2026-09-23 that had taken 22 of the feed's
 * 44 media while all 43 illustrated posts remained on screen, each rendering an expired box.
 *
 * The case that carries the most weight here is `removeAllOwnedBy`: the obvious way to write this
 * feature was to reuse `publicAsset`, which would ALSO have made an account deletion stop reaching
 * the departing member's post photos. Exemption from the idle sweep is not exemption from erasure,
 * and that distinction is only a comment in the source until something fails when it is removed.
 */
import { MediaService } from './media.service';

const UUID_CHAT = '11111111-1111-4111-8111-111111111111';
const UUID_ARCHIVE = '22222222-2222-4222-8222-222222222222';
const UUID_PURGED = '33333333-3333-4333-8333-333333333333';
const UUID_UNKNOWN = '44444444-4444-4444-8444-444444444444';

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
  storage: { delete: (id: string) => Promise<void> };
  logger: { log: (msg: string) => void; warn: (msg: string) => void };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
};

/** A service with planted metadata, a recording storage stub and persistence disabled. */
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
  };
  // The constructor is bypassed, so the Logger it would have built is not there. Silent rather
  // than piped to the console: a spec that prints teaches its reader to skip the line that matters.
  internals.logger = { log: () => {}, warn: () => {} };
  internals.persistMetadata = () => Promise.resolve();
  return { service, deleted };
}

/** Older than any retention window this service will ever be configured with. */
const LONG_IDLE = Date.now() - 400 * 24 * 60 * 60 * 1000;

describe('retention class: the idle sweep', () => {
  it('takes an idle chat object and leaves an idle archive object', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: { createdAt: LONG_IDLE, lastAccessAt: LONG_IDLE },
      [UUID_ARCHIVE]: {
        createdAt: LONG_IDLE,
        lastAccessAt: LONG_IDLE,
        retentionClass: 'archive',
      },
    };
    const { service, deleted } = serviceWith(items);

    await (service as unknown as ServiceInternals).purgeExpiredMedia();

    expect(deleted).toEqual([UUID_CHAT]);
    expect(items[UUID_CHAT].purgedAt).toBeDefined();
    expect(items[UUID_CHAT].purgeReason).toBe('retention_expired');
    // Untouched: no tombstone, and the class still on it.
    expect(items[UUID_ARCHIVE].purgedAt).toBeUndefined();
    expect(items[UUID_ARCHIVE].retentionClass).toBe('archive');
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

describe('MediaService.setRetentionClass', () => {
  it('archives live entries and reports how many actually changed', async () => {
    const items: Record<string, Entry> = {
      [UUID_CHAT]: { createdAt: 1, lastAccessAt: 1 },
      [UUID_ARCHIVE]: { createdAt: 1, lastAccessAt: 1, retentionClass: 'archive' },
    };
    const { service } = serviceWith(items);

    // Only the unclassified one is a change; re-applying a class it already holds is not.
    expect(await service.setRetentionClass([UUID_CHAT, UUID_ARCHIVE], 'archive')).toBe(1);
    expect(items[UUID_CHAT].retentionClass).toBe('archive');
  });

  it('releases an archived entry back to the idle window, which then sweeps it', async () => {
    const items: Record<string, Entry> = {
      [UUID_ARCHIVE]: {
        createdAt: LONG_IDLE,
        lastAccessAt: LONG_IDLE,
        retentionClass: 'archive',
      },
    };
    const { service, deleted } = serviceWith(items);

    expect(await service.setRetentionClass([UUID_ARCHIVE], null)).toBe(1);
    expect(items[UUID_ARCHIVE].retentionClass).toBeUndefined();

    // The release is not a delete: the object goes when the ordinary clock says so, not before.
    expect(deleted).toEqual([]);
    await (service as unknown as ServiceInternals).purgeExpiredMedia();
    expect(deleted).toEqual([UUID_ARCHIVE]);
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

    // A post row legitimately cites an object swept before any of this existed. Classifying it
    // would resurrect an entry the retention decision already closed.
    expect(await service.setRetentionClass([UUID_PURGED, UUID_UNKNOWN], 'archive')).toBe(0);
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
