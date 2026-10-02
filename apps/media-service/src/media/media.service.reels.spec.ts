/**
 * CanaReels' blob side: the claim, and the purge whose ONLY allowlist is ownership.
 *
 * The purge is destructive and driven by ids that live in a post row any member can write, so the
 * load-bearing cases are the ones where the id is SOMEBODY ELSE'S: a reel (or a comment under it)
 * that cites another member's blob must never get that blob deleted. The other weight is the
 * outcome vocabulary - `absent` is success, only `failed` may keep a reel's row alive - because the
 * worker's idempotence and its per-item isolation are built on those words.
 */
import { MediaService, isRetentionClass } from './media.service';

const ALICE = 'alice';
const BOB = 'bob';
const REEL = '11111111-1111-4111-8111-111111111111';
const COMMENT_MEDIA = '22222222-2222-4222-8222-222222222222';
const BOBS_CHAT = '33333333-3333-4333-8333-333333333333';
const VAULT = '44444444-4444-4444-8444-444444444444';
const LOGO = '55555555-5555-4555-8555-555555555555';
const STUCK = '66666666-6666-4666-8666-666666666666';
const GONE = '77777777-7777-4777-8777-777777777777';
const UNOWNED = '88888888-8888-4888-8888-888888888888';

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
    listObjects: () => Promise<Array<{ id: string; size: number; lastModifiedMs: number | null }>>;
  };
  logger: { log: (msg: string) => void; warn: (msg: string) => void };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  sweepIntervalMs: number;
};

const entry = (extra: Partial<Entry> = {}): Entry => ({
  createdAt: Date.now(),
  lastAccessAt: Date.now(),
  ...extra,
});

/** `failing` ids make the store throw, as a Garage outage or a refused delete would. */
function serviceWith(
  items: Record<string, Entry>,
  failing: string[] = []
): { service: MediaService; deleted: string[] } {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      if (failing.includes(id)) return Promise.reject(new Error('garage refused'));
      deleted.push(id);
      return Promise.resolve();
    },
    listObjects: () =>
      Promise.resolve(
        Object.keys(items)
          .filter((id) => !deleted.includes(id))
          .map((id) => ({ id, size: 10, lastModifiedMs: Date.now() }))
      ),
  };
  internals.logger = { log: () => {}, warn: () => {} };
  internals.persistMetadata = () => Promise.resolve();
  internals.sweepIntervalMs = 60_000;
  return { service, deleted };
}

describe('reel class and claim', () => {
  it('is a recognised class', () => {
    expect(isRetentionClass('reel')).toBe(true);
  });

  it('claims only what the named owner uploaded, and refuses everything else', async () => {
    const items: Record<string, Entry> = {
      [REEL]: entry({ ownerId: ALICE, retentionClass: 'ephemeral' }),
      [BOBS_CHAT]: entry({ ownerId: BOB, retentionClass: 'ephemeral' }),
      [UNOWNED]: entry({ retentionClass: 'ephemeral' }),
      [LOGO]: entry({ ownerId: ALICE, publicAsset: true, contentType: 'image/webp' }),
      [GONE]: entry({ ownerId: ALICE, purgedAt: Date.now(), purgeReason: 'manual_delete' }),
    };
    const { service } = serviceWith(items);

    const out = await service.claimReels(
      [REEL, BOBS_CHAT, UNOWNED, LOGO, GONE, 'not-a-uuid', '99999999-9999-4999-8999-999999999999'],
      ALICE
    );

    expect(out.claimed).toEqual([REEL]);
    expect(out.refused).toHaveLength(6);
    expect(items[REEL].retentionClass).toBe('reel');
    // Bob's blob is NOT reclassified by Alice naming it.
    expect(items[BOBS_CHAT].retentionClass).toBe('ephemeral');
    expect(items[UNOWNED].retentionClass).toBe('ephemeral');
  });

  it('is idempotent: claiming twice claims twice and changes nothing the second time', async () => {
    const items = { [REEL]: entry({ ownerId: ALICE }) };
    const { service } = serviceWith(items);
    expect((await service.claimReels([REEL], ALICE)).claimed).toEqual([REEL]);
    expect((await service.claimReels([REEL], ALICE)).claimed).toEqual([REEL]);
    expect(items[REEL].retentionClass).toBe('reel');
  });

  it('is kept by the idle sweep for ever, however idle', async () => {
    const long = Date.now() - 400 * 24 * 60 * 60 * 1000;
    const items = { [REEL]: entry({ ownerId: ALICE, retentionClass: 'reel', lastAccessAt: long }) };
    const { service, deleted } = serviceWith(items);
    await (service as unknown as ServiceInternals).purgeExpiredMedia();
    expect(deleted).toEqual([]);
  });

  it('is reported on its own line of the storage stats', async () => {
    const { service } = serviceWith({
      [REEL]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
      [COMMENT_MEDIA]: entry({ ownerId: ALICE, retentionClass: 'archive' }),
    });
    const stats = await service.getStorageStats();
    expect(stats.reelCount).toBe(1);
    expect(stats.reelBytes).toBe(10);
    expect(stats.archiveCount).toBe(1);
  });
});

describe('reel purge: ownership is the allowlist', () => {
  it('deletes the owner blobs - a reel and the commenter media - and tombstones them', async () => {
    const items: Record<string, Entry> = {
      [REEL]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
      [COMMENT_MEDIA]: entry({ ownerId: BOB, retentionClass: 'archive' }),
    };
    const { service, deleted } = serviceWith(items);

    const results = await service.purgeReels([
      { mediaId: REEL, ownerId: ALICE },
      { mediaId: COMMENT_MEDIA, ownerId: BOB },
    ]);

    expect(results).toEqual({ [REEL]: 'deleted', [COMMENT_MEDIA]: 'deleted' });
    expect(deleted).toEqual([REEL, COMMENT_MEDIA]);
    expect(items[REEL].purgedAt).toBeDefined();
    expect(items[REEL].purgeReason).toBe('manual_delete');
  });

  it("NEVER deletes somebody else's blob cited by a reel or a comment, nor a protected one", async () => {
    const items: Record<string, Entry> = {
      [BOBS_CHAT]: entry({ ownerId: BOB, retentionClass: 'ephemeral' }),
      [UNOWNED]: entry({ retentionClass: 'ephemeral' }),
      [VAULT]: entry({ ownerId: ALICE, retentionClass: 'association' }),
      [LOGO]: entry({ ownerId: ALICE, publicAsset: true, contentType: 'image/webp' }),
    };
    const { service, deleted } = serviceWith(items);

    const results = await service.purgeReels([
      // Alice's reel row cites Bob's chat photo, an old unowned blob, a vault document, a logo.
      { mediaId: BOBS_CHAT, ownerId: ALICE },
      { mediaId: UNOWNED, ownerId: ALICE },
      { mediaId: VAULT, ownerId: ALICE },
      { mediaId: LOGO, ownerId: ALICE },
      // And an empty owner is not "anybody".
      { mediaId: BOBS_CHAT, ownerId: '' },
    ]);

    expect(Object.values(results).every((r) => r === 'refused')).toBe(true);
    expect(deleted).toEqual([]);
    for (const id of [BOBS_CHAT, UNOWNED, VAULT, LOGO]) {
      expect(items[id].purgedAt).toBeUndefined();
    }
  });

  it('answers absent for what is already gone, so a retry after a crash succeeds', async () => {
    const items: Record<string, Entry> = {
      [GONE]: entry({ ownerId: ALICE, purgedAt: 1, purgeReason: 'retention_expired' }),
    };
    const { service, deleted } = serviceWith(items);

    const results = await service.purgeReels([
      { mediaId: GONE, ownerId: ALICE },
      { mediaId: '99999999-9999-4999-8999-999999999999', ownerId: ALICE },
    ]);

    expect(Object.values(results)).toEqual(['absent', 'absent']);
    expect(deleted).toEqual([]);
    // The existing tombstone keeps its own date and reason.
    expect(items[GONE].purgeReason).toBe('retention_expired');
  });

  it('is idempotent: the second run over the same items deletes nothing and fails nothing', async () => {
    const items: Record<string, Entry> = {
      [REEL]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
    };
    const { service, deleted } = serviceWith(items);
    const batch = [{ mediaId: REEL, ownerId: ALICE }];

    expect(await service.purgeReels(batch)).toEqual({ [REEL]: 'deleted' });
    expect(await service.purgeReels(batch)).toEqual({ [REEL]: 'absent' });
    expect(deleted).toEqual([REEL]);
  });

  it('isolates a failing object: it is `failed`, stays live and the rest proceed', async () => {
    const items: Record<string, Entry> = {
      [STUCK]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
      [REEL]: entry({ ownerId: ALICE, retentionClass: 'reel' }),
    };
    const { service, deleted } = serviceWith(items, [STUCK]);

    const results = await service.purgeReels([
      { mediaId: STUCK, ownerId: ALICE },
      { mediaId: REEL, ownerId: ALICE },
    ]);

    expect(results).toEqual({ [STUCK]: 'failed', [REEL]: 'deleted' });
    expect(deleted).toEqual([REEL]);
    // A failed delete is NOT tombstoned, or the retry would read it as `absent` and lose it.
    expect(items[STUCK].purgedAt).toBeUndefined();
  });
});
