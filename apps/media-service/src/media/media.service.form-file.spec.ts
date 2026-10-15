/**
 * The `form-file` class: the one PLAINTEXT class, readable by social-service alone, and the purge
 * whose allowlist is the class AND the uploader.
 *
 * The load-bearing cases are the ones where an id points at something that is NOT a form file of
 * the named uploader - a chat photo, a reel, a vault document, a logo, another member's CV - because
 * the purge is driven by ids that sit in answers a member wrote. And the member route must never
 * serve a form file, because it has no per-object ACL.
 */
import { Readable } from 'node:stream';
import { BadRequestException } from '@nestjs/common';
import { MediaService, isServerReadOnly } from './media.service';
import { clientRetentionClass } from './media.controller';

const ALICE = 'alice';
const BOB = 'bob';
const CV = '11111111-1111-4111-8111-111111111111';
const BOBS_CV = '22222222-2222-4222-8222-222222222222';
const ALICES_CHAT = '33333333-3333-4333-8333-333333333333';
const ALICES_REEL = '44444444-4444-4444-8444-444444444444';
const VAULT = '55555555-5555-4555-8555-555555555555';
const STUCK = '66666666-6666-4666-8666-666666666666';
const GONE = '77777777-7777-4777-8777-777777777777';

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
    put: (id: string, data: Buffer, size: number) => Promise<void>;
    get: (id: string) => Promise<NodeJS.ReadableStream | null>;
    delete: (id: string) => Promise<void>;
  };
  logger: { log: () => void; warn: () => void; debug: () => void };
  persistMetadata: () => Promise<void>;
};

const entry = (extra: Partial<Entry> = {}): Entry => ({
  createdAt: Date.now(),
  lastAccessAt: Date.now(),
  ...extra,
});

function serviceWith(
  items: Record<string, Entry>,
  failing: string[] = []
): { service: MediaService; deleted: string[]; stored: string[] } {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const stored: string[] = [];
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    put: (id: string) => {
      stored.push(id);
      return Promise.resolve();
    },
    get: () => Promise.resolve(null),
    delete: (id: string) => {
      if (failing.includes(id)) return Promise.reject(new Error('garage refused'));
      deleted.push(id);
      return Promise.resolve();
    },
  };
  internals.logger = { log: () => {}, warn: () => {}, debug: () => {} };
  internals.persistMetadata = () => Promise.resolve();
  return { service, deleted, stored };
}

const formFile = (ownerId: string) => entry({ retentionClass: 'form-file', ownerId });

describe('form-file: stored by social-service, read by nobody else', () => {
  it('stores the bytes as form-file for the named uploader, with NO content type', async () => {
    const items: Record<string, Entry> = {};
    const { service, stored } = serviceWith(items);
    const id = await service.uploadFormFile(Buffer.from('%PDF-1.7'), ALICE);
    expect(stored).toEqual([id]);
    expect(items[id].retentionClass).toBe('form-file');
    expect(items[id].ownerId).toBe(ALICE);
    // An `image/*` content type is what the public route reads as "public": never recorded here.
    expect(items[id].contentType).toBeUndefined();
    expect(isServerReadOnly(items[id] as never)).toBe(true);
  });

  it('refuses an upload with no uploader', async () => {
    const { service } = serviceWith({});
    await expect(service.uploadFormFile(Buffer.from('x'), '')).rejects.toThrow(BadRequestException);
  });

  it('answers 404 on the member route (GET /media/:id), whole or ranged', async () => {
    const { service } = serviceWith({ [CV]: formFile(ALICE) });
    expect(await service.downloadRange(CV, undefined)).toEqual({ status: 'not_found' });
    expect(await service.downloadRange(CV, 'bytes=0-3')).toEqual({ status: 'not_found' });
  });

  // `GET /media/internal/:id` is the push media proxy's read, reached from any member's device.
  it('is absent to an ordinary read, and served only to a read that asks for a form file', async () => {
    const { service } = serviceWith({ [CV]: formFile(ALICE), [ALICES_CHAT]: entry() });
    (service as unknown as ServiceInternals).storage.get = () =>
      Promise.resolve(Readable.from([Buffer.from('%PDF-1.7')]));
    expect(await service.download(CV)).toEqual({ status: 'not_found' });
    expect((await service.download(CV, true)).status).toBe('ok');
    // ...and the form-file read serves nothing else.
    expect(await service.download(ALICES_CHAT, true)).toEqual({ status: 'not_found' });
    expect((await service.download(ALICES_CHAT)).status).toBe('ok');
  });

  it('is not served by the public route', async () => {
    const { service } = serviceWith({ [CV]: formFile(ALICE) });
    expect(await service.downloadPublic(CV)).toEqual({ status: 'not_found' });
  });

  it('keeps its class: internal/retention-class cannot move it onto any other', async () => {
    const items = { [CV]: formFile(ALICE) };
    const { service } = serviceWith(items);
    expect(await service.setRetentionClass([CV], 'archive')).toBe(0);
    expect(items[CV].retentionClass).toBe('form-file');
  });

  it('cannot be claimed as a reel, nor promoted to a public asset', async () => {
    const { service } = serviceWith({ [CV]: formFile(ALICE) });
    expect(await service.claimReels([CV], ALICE)).toEqual({ claimed: [], refused: [CV] });
    expect((await service.promoteToPublicAssets([CV])).refused).toEqual([CV]);
  });

  it('is a name no client upload route accepts', () => {
    expect(() => clientRetentionClass('form-file')).toThrow(BadRequestException);
    expect(clientRetentionClass('chat-reel')).toBe('chat-reel');
    expect(clientRetentionClass('not-a-class')).toBeUndefined();
  });
});

describe('purgeFormFiles: the allowlist is the class AND the uploader', () => {
  it('deletes the uploader own form file and tombstones it retention_expired', async () => {
    const items = { [CV]: formFile(ALICE) };
    const { service, deleted } = serviceWith(items);
    expect(await service.purgeFormFiles([{ mediaId: CV, ownerId: ALICE }])).toEqual({
      [CV]: 'deleted',
    });
    expect(deleted).toEqual([CV]);
    expect(items[CV].purgedAt).toBeDefined();
    expect(items[CV].purgeReason).toBe('retention_expired');
  });

  // An id quoted in an answer is not a licence: the SAME uploader's chat photo, reel or vault
  // document is refused and left in place.
  it.each([
    ['a chat photo', ALICES_CHAT, entry({ retentionClass: 'ephemeral', ownerId: ALICE })],
    ['a reel', ALICES_REEL, entry({ retentionClass: 'reel', ownerId: ALICE })],
    ['a vault document', VAULT, entry({ retentionClass: 'association', ownerId: ALICE })],
    ['an unclassified object', GONE, entry({ ownerId: ALICE })],
  ])('refuses %s of the same uploader', async (_what, id, e) => {
    const { service, deleted } = serviceWith({ [id]: e });
    expect(await service.purgeFormFiles([{ mediaId: id, ownerId: ALICE }])).toEqual({
      [id]: 'refused',
    });
    expect(deleted).toEqual([]);
  });

  it('refuses another member form file', async () => {
    const { service, deleted } = serviceWith({ [BOBS_CV]: formFile(BOB) });
    expect(await service.purgeFormFiles([{ mediaId: BOBS_CV, ownerId: ALICE }])).toEqual({
      [BOBS_CV]: 'refused',
    });
    expect(deleted).toEqual([]);
  });

  it('answers absent for an unknown or already purged id - the rerun after a crash', async () => {
    const { service, deleted } = serviceWith({
      [GONE]: entry({ retentionClass: 'form-file', ownerId: ALICE, purgedAt: 1 }),
    });
    expect(
      await service.purgeFormFiles([
        { mediaId: GONE, ownerId: ALICE },
        { mediaId: CV, ownerId: ALICE },
      ])
    ).toEqual({ [GONE]: 'absent', [CV]: 'absent' });
    expect(deleted).toEqual([]);
  });

  it('isolates a store failure: failed for that one, the next is still deleted', async () => {
    const items = { [STUCK]: formFile(ALICE), [CV]: formFile(ALICE) };
    const { service, deleted } = serviceWith(items, [STUCK]);
    expect(
      await service.purgeFormFiles([
        { mediaId: STUCK, ownerId: ALICE },
        { mediaId: CV, ownerId: ALICE },
      ])
    ).toEqual({ [STUCK]: 'failed', [CV]: 'deleted' });
    expect(deleted).toEqual([CV]);
    expect(items[STUCK].purgedAt).toBeUndefined();
  });

  it('refuses a malformed id', async () => {
    const { service } = serviceWith({});
    expect(await service.purgeFormFiles([{ mediaId: '../x', ownerId: ALICE }])).toEqual({
      '../x': 'refused',
    });
  });
});
