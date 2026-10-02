/**
 * `MediaService.downloadPublic` - the one media route that answers a caller with no session.
 *
 * `GET /media/public/:id` is reached by an `<img>` on pages a signed-out visitor sees, so it cannot
 * carry a Bearer and is declared public by intent. That makes what it will serve the whole of its
 * security, and until 2026-09-10 the answer was "anything": a fallback for a lost metadata index
 * served whatever storage held under that UUID and then WROTE `publicAsset: true` for it, turning a
 * private object into a public one, permanently, on one request from anybody.
 *
 * These cases are built around that: what it serves, and - as much - what it must refuse to WRITE.
 */
import { MediaService } from './media.service';

const UUID_PUBLIC = '11111111-1111-4111-8111-111111111111';
const UUID_PRIVATE = '22222222-2222-4222-8222-222222222222';
const UUID_UNKNOWN = '33333333-3333-4333-8333-333333333333';

type MetaEntry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  publicAsset?: boolean;
  contentType?: string;
};

type ServiceInternals = {
  meta: { items: Record<string, MetaEntry> };
  storage: { get: (id: string) => Promise<unknown> };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  logger: { warn: (m: string) => void; log: (m: string) => void };
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
 * A service with its metadata planted and storage stubbed.
 *
 * `storedIds` is what the BUCKET holds, deliberately separate from the metadata index: the defect
 * lived exactly in the gap between the two, so a test that could not express "stored but not
 * indexed" could not have caught it.
 */
function serviceWith(items: Record<string, MetaEntry>, storedIds: string[]) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const internals = service as unknown as ServiceInternals;
  let persistCalls = 0;
  internals.meta = { items };
  internals.storage = {
    get: (id: string) =>
      Promise.resolve(storedIds.includes(id) ? streamOf(Buffer.from('bytes')) : null),
  };
  internals.persistMetadata = () => {
    persistCalls += 1;
    return Promise.resolve();
  };
  internals.purgeExpiredMedia = () => Promise.resolve();
  internals.logger = { warn: () => {}, log: () => {} };
  return { service, persisted: () => persistCalls };
}

describe('MediaService.downloadPublic', () => {
  const NOW = 1_000;

  it('serves an object the index says is a public asset', async () => {
    const items = {
      [UUID_PUBLIC]: {
        createdAt: NOW,
        lastAccessAt: NOW,
        publicAsset: true,
        contentType: 'image/webp',
      },
    };
    const { service } = serviceWith(items, [UUID_PUBLIC]);

    const result = await service.downloadPublic(UUID_PUBLIC);
    expect(result).toMatchObject({ status: 'ok', contentType: 'image/webp' });
  });

  it('REFUSES an object that is stored but not indexed, and writes nothing for it', async () => {
    // The defect, stated as a test. `UUID_PRIVATE` is in the bucket with no metadata entry - the
    // shape a chat ciphertext takes after an index loss - and the old fallback served it AND
    // recorded it as a public asset.
    const items: Record<string, MetaEntry> = {};
    const { service, persisted } = serviceWith(items, [UUID_PRIVATE]);

    expect((await service.downloadPublic(UUID_PRIVATE)).status).toBe('not_found');
    expect(items[UUID_PRIVATE]).toBeUndefined();
    expect(persisted()).toBe(0);
  });

  it('refuses an object the index knows about but does not call public', async () => {
    const items: Record<string, MetaEntry> = {
      [UUID_PRIVATE]: {
        createdAt: NOW,
        lastAccessAt: NOW,
        contentType: 'application/octet-stream',
      },
    };
    const { service, persisted } = serviceWith(items, [UUID_PRIVATE]);

    expect((await service.downloadPublic(UUID_PRIVATE)).status).toBe('not_found');
    expect(items[UUID_PRIVATE].publicAsset).toBeUndefined();
    expect(persisted()).toBe(0);
  });

  it('refuses a public asset whose bytes are gone, rather than answering with nothing', async () => {
    const items = {
      [UUID_PUBLIC]: {
        createdAt: NOW,
        lastAccessAt: NOW,
        publicAsset: true,
        contentType: 'image/webp',
      },
    };
    const { service } = serviceWith(items, []);

    expect((await service.downloadPublic(UUID_PUBLIC)).status).toBe('not_found');
  });

  it('refuses a purged public asset instead of resurrecting it', async () => {
    const items = {
      [UUID_PUBLIC]: {
        createdAt: NOW,
        lastAccessAt: NOW,
        purgedAt: NOW,
        publicAsset: true,
        contentType: 'image/webp',
      },
    };
    const { service } = serviceWith(items, [UUID_PUBLIC]);

    expect((await service.downloadPublic(UUID_PUBLIC)).status).toBe('not_found');
  });

  it('refuses an id that is not a UUID before asking storage anything', async () => {
    const { service } = serviceWith({}, []);
    await expect(service.downloadPublic('../../etc/passwd')).rejects.toThrow(/Invalid mediaId/);
    await expect(service.downloadPublic(UUID_UNKNOWN)).resolves.toEqual({ status: 'not_found' });
  });
});

describe('MediaService.promoteToPublicAssets', () => {
  const NOW = 1_000;
  const UUID_CIPHER = '44444444-4444-4444-8444-444444444444';

  /** A 1x1 PNG, the smallest thing sharp decodes. */
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  function serviceHolding(items: Record<string, MetaEntry>, blobs: Record<string, Buffer>) {
    const { service, persisted } = serviceWith(items, []);
    (service as unknown as ServiceInternals).storage = {
      get: (id: string) => Promise.resolve(blobs[id] ? streamOf(blobs[id]) : null),
    };
    return { service, persisted };
  }

  it('promotes an image uploaded behind the JWT route and serves it publicly afterwards', async () => {
    const items: Record<string, MetaEntry> = {
      [UUID_PRIVATE]: { createdAt: NOW, lastAccessAt: NOW },
    };
    const { service } = serviceHolding(items, { [UUID_PRIVATE]: PNG });

    expect((await service.downloadPublic(UUID_PRIVATE)).status).toBe('not_found');
    const result = await service.promoteToPublicAssets([UUID_PRIVATE]);

    expect(result).toEqual({ promoted: [UUID_PRIVATE], refused: [] });
    expect(await service.downloadPublic(UUID_PRIVATE)).toMatchObject({
      status: 'ok',
      contentType: 'image/png',
    });
  });

  it('REFUSES a blob that is not an image, so a wrong id cannot publish ciphertext', async () => {
    const items: Record<string, MetaEntry> = {
      [UUID_CIPHER]: { createdAt: NOW, lastAccessAt: NOW },
    };
    const { service, persisted } = serviceHolding(items, {
      [UUID_CIPHER]: Buffer.from('not an image, just ciphertext'),
    });

    const result = await service.promoteToPublicAssets([UUID_CIPHER, UUID_UNKNOWN, 'nope']);

    expect(result.promoted).toEqual([]);
    expect(result.refused).toEqual([UUID_CIPHER, UUID_UNKNOWN, 'nope']);
    expect(items[UUID_CIPHER].publicAsset).toBeUndefined();
    expect(persisted()).toBe(0);
  });
});
