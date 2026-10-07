/**
 * `MediaService.downloadRange` - one segment of a blob at a time (CanaReels R2).
 *
 * What these cases hold: a part is read FROM THE STORE as a part (never the whole object sliced
 * here), a range past the end is how a truncated blob is seen, the retention tombstone answers a
 * part exactly as it answers the whole, and the access clock moves once per OPENING rather than once
 * per megabyte.
 */
import { MediaService } from './media.service';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_PURGED = '33333333-3333-4333-8333-333333333333';
const UUID_MISSING = '44444444-4444-4444-8444-444444444444';

type MetaEntry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: string;
};

type ServiceInternals = {
  meta: { items: Record<string, MetaEntry> };
  storage: {
    get: (id: string) => Promise<unknown>;
    size: (id: string) => Promise<number | null>;
    getRange: (id: string, offset: number, length: number) => Promise<unknown>;
  };
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
  logger: { warn: (m: string) => void; log: (m: string) => void; debug: (m: string) => void };
};

function streamOf(bytes: Buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

const BLOB = Buffer.from(Array.from({ length: 100 }, (_, i) => i));

function serviceWith(items: Record<string, MetaEntry>) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const internals = service as unknown as ServiceInternals;
  const reads: { kind: 'whole' | 'range'; offset?: number; length?: number }[] = [];
  let persistCalls = 0;
  internals.meta = { items };
  internals.storage = {
    get: (id) => {
      reads.push({ kind: 'whole' });
      return Promise.resolve(id === UUID_A ? streamOf(BLOB) : null);
    },
    size: (id) => Promise.resolve(id === UUID_A ? BLOB.length : null),
    getRange: (id, offset, length) => {
      reads.push({ kind: 'range', offset, length });
      return Promise.resolve(
        id === UUID_A ? streamOf(BLOB.subarray(offset, offset + length)) : null
      );
    },
  };
  internals.persistMetadata = () => {
    persistCalls += 1;
    return Promise.resolve();
  };
  internals.purgeExpiredMedia = () => Promise.resolve();
  internals.logger = { warn: () => {}, log: () => {}, debug: () => {} };
  return { service, reads, persisted: () => persistCalls, items };
}

describe('MediaService.downloadRange', () => {
  const OLD = 1_000;

  it('serves the whole object when no range is asked, as download always did', async () => {
    const { service } = serviceWith({ [UUID_A]: { createdAt: OLD, lastAccessAt: OLD } });
    const result = await service.downloadRange(UUID_A, undefined);
    expect(result).toMatchObject({ status: 'ok', size: 100, range: null });
    expect(result.status === 'ok' && result.data.equals(BLOB)).toBe(true);
  });

  it('reads a part from the store as a part, and names the whole size', async () => {
    const { service, reads } = serviceWith({ [UUID_A]: { createdAt: OLD, lastAccessAt: OLD } });
    const result = await service.downloadRange(UUID_A, 'bytes=20-29');
    expect(result).toMatchObject({ status: 'ok', size: 100, range: { start: 20, end: 29 } });
    expect(result.status === 'ok' && [...result.data]).toEqual(
      Array.from({ length: 10 }, (_, i) => 20 + i)
    );
    expect(reads).toEqual([{ kind: 'range', offset: 20, length: 10 }]);
  });

  it('clamps a range past the end - the reader opens with "header and a whole segment"', async () => {
    const { service } = serviceWith({ [UUID_A]: { createdAt: OLD, lastAccessAt: OLD } });
    const result = await service.downloadRange(UUID_A, 'bytes=0-1048595');
    expect(result).toMatchObject({ status: 'ok', range: { start: 0, end: 99 } });
  });

  it('answers unsatisfiable for a range that starts past the end - a truncated blob', async () => {
    const { service, reads } = serviceWith({ [UUID_A]: { createdAt: OLD, lastAccessAt: OLD } });
    expect(await service.downloadRange(UUID_A, 'bytes=100-199')).toEqual({
      status: 'unsatisfiable',
      size: 100,
    });
    expect(reads).toEqual([]);
  });

  it('answers purged for a part of a purged object, exactly as for the whole', async () => {
    const { service } = serviceWith({
      [UUID_PURGED]: {
        createdAt: OLD,
        lastAccessAt: OLD,
        purgedAt: OLD,
        purgeReason: 'retention_expired',
      },
    });
    expect(await service.downloadRange(UUID_PURGED, 'bytes=0-9')).toEqual({ status: 'purged' });
  });

  it('answers not found for an object the store does not hold', async () => {
    const { service } = serviceWith({});
    expect(await service.downloadRange(UUID_MISSING, 'bytes=0-9')).toEqual({
      status: 'not_found',
    });
  });

  it('classifies a whole download: tombstone is purged, no object and no entry is not_found', async () => {
    // The two answers the client tells apart (410 -> expired, 404 -> not-found, both permanent and
    // never retried). A tombstone trimmed after its own window leaves nothing to tell a purge from
    // an id that never existed, so that case is a 404 by construction, not by a lost file.
    const { service } = serviceWith({
      [UUID_PURGED]: {
        createdAt: OLD,
        lastAccessAt: OLD,
        purgedAt: OLD,
        purgeReason: 'retention_expired',
      },
    });
    expect(await service.download(UUID_PURGED)).toEqual({ status: 'purged' });
    expect(await service.download(UUID_MISSING)).toEqual({ status: 'not_found' });
  });

  it('moves the access clock on the opening part only, not on every segment', async () => {
    const { service, persisted, items } = serviceWith({
      [UUID_A]: { createdAt: OLD, lastAccessAt: OLD },
    });
    await service.downloadRange(UUID_A, 'bytes=40-49');
    expect(items[UUID_A].lastAccessAt).toBe(OLD);
    expect(persisted()).toBe(0);

    await service.downloadRange(UUID_A, 'bytes=0-9');
    expect(items[UUID_A].lastAccessAt).toBeGreaterThan(OLD);
    expect(persisted()).toBe(1);
  });

  it('refuses an id that is not a UUID before touching the store', async () => {
    const { service, reads } = serviceWith({});
    await expect(service.downloadRange('../etc/passwd', 'bytes=0-9')).rejects.toThrow(
      'Invalid mediaId'
    );
    expect(reads).toEqual([]);
  });
});
