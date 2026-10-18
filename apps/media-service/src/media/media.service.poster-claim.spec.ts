/**
 * A booking space's poster is claimed through its UPLOADER (review of #2045): an id is not a
 * secret, and what a space does with its poster later is destructive (release to the idle sweep)
 * or protective (`association` outlives the uploader's erasure). So only the member's own fresh,
 * unclassified upload may become a poster - never another member's image, an association
 * document, a form file, or one of the member's own older post images.
 */
import { MediaService, POSTER_CLAIM_WINDOW_MS } from './media.service';

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

const upload = (extra: Partial<Entry> = {}): Entry => ({
  createdAt: NOW - 60_000,
  lastAccessAt: NOW - 60_000,
  retentionClass: 'archive',
  ownerId: ALICE,
  ...extra,
});

describe('claimPosters', () => {
  it("claims the member's own fresh upload, in the class asked", async () => {
    const items = { [id(1)]: upload(), [id(2)]: upload() };
    const { service, persisted } = serviceWith(items);
    expect(await service.claimPosters([id(1)], ALICE, 'association', NOW)).toEqual({
      claimed: [id(1)],
      refused: [],
    });
    expect(items[id(1)].retentionClass).toBe('association');
    expect(await service.claimPosters([id(2)], ALICE, 'archive', NOW)).toEqual({
      claimed: [id(2)],
      refused: [],
    });
    expect(items[id(2)].retentionClass).toBe('archive');
    expect(persisted).toHaveLength(1);
  });

  it("refuses another member's object, whatever its class", async () => {
    const items = { [id(1)]: upload({ ownerId: BOB }) };
    const { service } = serviceWith(items);
    expect((await service.claimPosters([id(1)], ALICE, 'association', NOW)).refused).toEqual([
      id(1),
    ]);
    expect(items[id(1)].retentionClass).toBe('archive');
  });

  it('refuses an object some other surface already classified, or a stale upload', async () => {
    const items = {
      [id(1)]: upload({ retentionClass: 'association' }),
      [id(2)]: upload({ retentionClass: 'form-file' }),
      [id(3)]: upload({ retentionClass: 'ephemeral' }),
      [id(4)]: upload({ createdAt: NOW - POSTER_CLAIM_WINDOW_MS - 1 }),
      [id(5)]: upload({ ownerId: undefined }),
      [id(6)]: upload({ purgedAt: NOW - 1 }),
      [id(7)]: upload({ publicAsset: true, contentType: 'image/png' }),
    };
    const { service } = serviceWith(items);
    const ids = [1, 2, 3, 4, 5, 6, 7].map(id);
    const out = await service.claimPosters([...ids, 'not-an-id'], ALICE, 'archive', NOW);
    expect(out.claimed).toEqual([]);
    expect(out.refused).toEqual([...ids, 'not-an-id']);
    expect(items[id(1)].retentionClass).toBe('association');
    expect(items[id(3)].retentionClass).toBe('ephemeral');
  });
});
