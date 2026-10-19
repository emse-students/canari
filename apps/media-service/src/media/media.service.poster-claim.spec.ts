/**
 * A booking space's poster is claimed through its UPLOADER (review of #2045): an id is not a
 * secret, and what a space does with its poster later is destructive (release to the idle sweep)
 * or protective (`poster-association` outlives the uploader's erasure). So only the member's own fresh
 * `poster-pending` upload may become a poster - never another member's image, nor any object
 * another surface uses (a post image, a document), even the member's own; and a release touches
 * claimed posters alone.
 */
import { MediaService, POSTER_CLAIM_WINDOW_MS, POSTER_PENDING_TTL_MS } from './media.service';

const ALICE = 'alice';
const BOB = 'bob';
const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const NOW = 1_800_000_000_000;

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  publicAsset?: boolean;
  retentionClass?: string;
  ownerId?: string;
  contentType?: string;
  claimedFor?: string;
};

function serviceWith(items: Record<string, Entry>): { service: MediaService; persisted: number[] } {
  const service = Object.create(MediaService.prototype) as MediaService;
  const persisted: number[] = [];
  const internals = service as unknown as {
    meta: { items: Record<string, Entry> };
    logger: { log: () => void; warn: () => void; debug: () => void };
    persistMetadata: () => Promise<void>;
  };
  internals.meta = { items };
  internals.logger = { log: () => {}, warn: () => {}, debug: () => {} };
  internals.persistMetadata = () => {
    persisted.push(1);
    return Promise.resolve();
  };
  return { service, persisted };
}

const SPACE = 'space-1';
const OTHER_SPACE = 'space-2';

const upload = (extra: Partial<Entry> = {}): Entry => ({
  createdAt: NOW - 60_000,
  lastAccessAt: NOW - 60_000,
  retentionClass: 'poster-pending',
  ownerId: ALICE,
  ...extra,
});

describe('claimPosters', () => {
  it("claims the member's own fresh poster upload, in the class asked, bound to its space", async () => {
    const items: Record<string, Entry> = {
      [id(1)]: upload(),
      [id(2)]: upload(),
    };
    const { service, persisted } = serviceWith(items);
    expect(await service.claimPosters([id(1)], ALICE, SPACE, 'poster-association', NOW)).toEqual({
      claimed: [id(1)],
      refused: [],
    });
    expect([items[id(1)].retentionClass, items[id(1)].claimedFor]).toEqual([
      'poster-association',
      SPACE,
    ]);
    expect(await service.claimPosters([id(2)], ALICE, SPACE, 'poster', NOW)).toEqual({
      claimed: [id(2)],
      refused: [],
    });
    expect(items[id(2)].retentionClass).toBe('poster');
    expect(persisted).toHaveLength(2);
  });

  it('is idempotent for the same owner and space, and refuses the object for any other space', async () => {
    const items: Record<string, Entry> = { [id(1)]: upload() };
    const { service, persisted } = serviceWith(items);
    await service.claimPosters([id(1)], ALICE, SPACE, 'poster', NOW);
    // A double submit, or a retried save, past the claim window even: claimed again, nothing moves.
    const again = await service.claimPosters(
      [id(1)],
      ALICE,
      SPACE,
      'poster',
      NOW + 2 * POSTER_CLAIM_WINDOW_MS
    );
    expect(again).toEqual({ claimed: [id(1)], refused: [] });
    expect(persisted).toHaveLength(1);
    expect(
      (await service.claimPosters([id(1)], ALICE, OTHER_SPACE, 'poster', NOW)).refused
    ).toEqual([id(1)]);
    expect((await service.claimPosters([id(1)], BOB, SPACE, 'poster', NOW)).refused).toEqual([
      id(1),
    ]);
    expect(items[id(1)].claimedFor).toBe(SPACE);
  });

  it("refuses another member's upload", async () => {
    const items = { [id(1)]: upload({ ownerId: BOB }) };
    const { service } = serviceWith(items);
    expect(
      (await service.claimPosters([id(1)], ALICE, SPACE, 'poster-association', NOW)).refused
    ).toEqual([id(1)]);
    expect(items[id(1)].retentionClass).toBe('poster-pending');
  });

  it("refuses the member's OWN post image, document or chat photo - only a poster upload qualifies", async () => {
    const items = {
      [id(1)]: upload({ retentionClass: 'archive' }),
      [id(2)]: upload({ retentionClass: 'association' }),
      [id(3)]: upload({ retentionClass: 'ephemeral' }),
      [id(4)]: upload({ retentionClass: 'form-file' }),
      [id(5)]: upload({ retentionClass: undefined }),
      [id(6)]: upload({ createdAt: NOW - POSTER_CLAIM_WINDOW_MS - 1 }),
      [id(7)]: upload({ ownerId: undefined }),
      [id(8)]: upload({ purgedAt: NOW - 1 }),
      [id(9)]: upload({ publicAsset: true, contentType: 'image/png' }),
    };
    const { service } = serviceWith(items);
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(id);
    const out = await service.claimPosters([...ids, 'not-an-id'], ALICE, SPACE, 'poster', NOW);
    expect(out.claimed).toEqual([]);
    expect(out.refused).toEqual([...ids, 'not-an-id']);
    expect(items[id(1)].retentionClass).toBe('archive');
    expect(items[id(2)].retentionClass).toBe('association');
  });
});

describe('releasePosters', () => {
  it('releases a claimed poster and NOTHING else, whatever id it is handed', async () => {
    const items: Record<string, Entry> = {
      [id(1)]: upload({ retentionClass: 'poster', claimedFor: SPACE }),
      [id(2)]: upload({ retentionClass: 'poster-association', claimedFor: OTHER_SPACE }),
      [id(3)]: upload({ retentionClass: 'archive' }),
      [id(4)]: upload({ retentionClass: 'association' }),
      [id(5)]: upload(),
    };
    const { service } = serviceWith(items);
    const out = await service.releasePosters([1, 2, 3, 4, 5].map(id));
    expect(out).toEqual({ released: [id(1), id(2)], refused: [id(3), id(4), id(5)] });
    expect([1, 2, 3, 4, 5].map((n) => items[id(n)].retentionClass)).toEqual([
      'ephemeral',
      'ephemeral',
      'archive',
      'association',
      'poster-pending',
    ]);
    expect(items[id(1)].claimedFor).toBeUndefined();
  });

  it('lists the claimed posters with their space, and no other class moves a claimed poster', async () => {
    const items: Record<string, Entry> = {
      [id(1)]: upload({ retentionClass: 'poster', claimedFor: SPACE }),
      [id(2)]: upload(),
      [id(3)]: upload({
        retentionClass: 'poster-association',
        claimedFor: OTHER_SPACE,
        purgedAt: 1,
      }),
    };
    const { service } = serviceWith(items);
    expect(service.listPosters()).toEqual([{ mediaId: id(1), spaceId: SPACE }]);
    expect(await service.setRetentionClass([id(1)], 'ephemeral')).toBe(0);
    expect(items[id(1)].retentionClass).toBe('poster');
  });
});

describe('the poster classes and the sweep', () => {
  it('sweeps an unclaimed poster upload by age, after any claim could still take it; keeps claimed ones', () => {
    const { service } = serviceWith({});
    const internals = service as unknown as {
      isDue: (e: Entry, now: number) => boolean;
      survivesAccountDeletion: (e: Entry) => boolean;
    };
    const atClaimEdge = upload({ createdAt: NOW - POSTER_CLAIM_WINDOW_MS });
    expect(internals.isDue(atClaimEdge, NOW)).toBe(false);
    expect(internals.isDue(upload({ createdAt: NOW - POSTER_PENDING_TTL_MS - 1 }), NOW)).toBe(true);
    for (const cls of ['poster', 'poster-association']) {
      expect(
        internals.isDue(upload({ retentionClass: cls, createdAt: 0, lastAccessAt: 0 }), NOW)
      ).toBe(false);
    }
    expect(
      internals.survivesAccountDeletion(upload({ retentionClass: 'poster-association' }))
    ).toBe(true);
    expect(internals.survivesAccountDeletion(upload({ retentionClass: 'poster' }))).toBe(false);
  });
});
