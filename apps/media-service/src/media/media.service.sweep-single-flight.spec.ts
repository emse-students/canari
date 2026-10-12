/**
 * The retention sweep is SINGLE-FLIGHT, and a download never waits behind it (review of #1744).
 *
 * Pinned because the opposite is what shipped first: boot, the interval and every download each
 * started their own run, so the per-run cap of 500 was an allowance per CALLER - N overlapping
 * callers could delete N x 500 objects at once - and every read waited for a whole sweep of the
 * index to learn whether the one object it asked for was due.
 */
import { MediaService } from './media.service';

type Entry = {
  createdAt: number;
  lastAccessAt: number;
  purgedAt?: number;
  purgeReason?: string;
  retentionClass?: string;
  ownerId?: string;
};

type ServiceInternals = {
  meta: { items: Record<string, Entry> };
  storage: Record<string, unknown>;
  logger: Record<'log' | 'debug' | 'warn' | 'error', (msg: string) => void>;
  persistMetadata: () => Promise<void>;
  purgeExpiredMedia: () => Promise<void>;
};

const DAY = 24 * 60 * 60 * 1000;
/** The production ceiling (`PURGE_MAX_PER_RUN`); not exported, so restated here and asserted. */
const CAP = 500;

/** A UUID v4-shaped id for index `i` (the service validates ids on its download paths). */
function uuidFor(i: number): string {
  const hex = i.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function streamOf(bytes: Buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

/**
 * A service over `items`, whose storage delete yields to the event loop (the real one is network
 * I/O) - or, with `gate`, blocks until the test opens it, so a sweep can be held in flight.
 */
function serviceWith(items: Record<string, Entry>, gate?: Promise<void>) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deleted: string[] = [];
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.storage = {
    delete: async (id: string) => {
      await (gate ?? new Promise((resolve) => setImmediate(resolve)));
      deleted.push(id);
    },
    get: (id: string) =>
      Promise.resolve(deleted.includes(id) ? null : streamOf(Buffer.from('ciphertext'))),
  };
  internals.logger = { log: () => {}, debug: () => {}, warn: () => {}, error: () => {} };
  internals.persistMetadata = () => Promise.resolve();
  return { service, internals, deleted };
}

/** `count` ephemeral objects idle for far longer than the retention window - all due. */
function dueItems(count: number, from = 0): Record<string, Entry> {
  const items: Record<string, Entry> = {};
  for (let i = from; i < from + count; i += 1) {
    items[uuidFor(i)] = {
      createdAt: Date.now() - 400 * DAY,
      lastAccessAt: Date.now() - 400 * DAY,
      retentionClass: 'ephemeral',
    };
  }
  return items;
}

describe('retention sweep: single-flight', () => {
  it('bounds deletions by the per-run cap ACROSS concurrent callers', async () => {
    const items = dueItems(CAP * 3);
    const { internals, deleted } = serviceWith(items);

    // Boot, the interval and a manual run all landing at once: one run, one cap.
    const calls = [
      internals.purgeExpiredMedia(),
      internals.purgeExpiredMedia(),
      internals.purgeExpiredMedia(),
    ];
    expect(calls[1]).toBe(calls[0]);
    expect(calls[2]).toBe(calls[0]);
    await Promise.all(calls);

    expect(deleted).toHaveLength(CAP);
    expect(Object.values(items).filter((e) => e.purgedAt)).toHaveLength(CAP);
  });

  it('starts a fresh run once the previous one settled - the cap is per run, not for ever', async () => {
    const items = dueItems(CAP + 10);
    const { internals, deleted } = serviceWith(items);

    await internals.purgeExpiredMedia();
    expect(deleted).toHaveLength(CAP);

    await internals.purgeExpiredMedia();
    expect(deleted).toHaveLength(CAP + 10);
  });
});

describe('retention sweep: a download never waits behind it', () => {
  it('serves a live object while a sweep is held in flight', async () => {
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const live = uuidFor(999_999);
    const items: Record<string, Entry> = {
      ...dueItems(3),
      [live]: { createdAt: Date.now(), lastAccessAt: Date.now(), retentionClass: 'ephemeral' },
    };
    const { service, internals } = serviceWith(items, gate);

    const sweep = internals.purgeExpiredMedia();
    // The sweep is parked on its first delete; the download must answer anyway.
    expect((await service.download(live)).status).toBe('ok');

    open();
    await sweep;
  });

  it('answers `purged` for a due object the sweep has not reached, by judging that entry alone', async () => {
    const items = dueItems(3);
    const { service, deleted } = serviceWith(items);
    const target = uuidFor(2);

    expect((await service.download(target)).status).toBe('purged');

    // Only its own entry: the two other due objects wait for the sweep.
    expect(deleted).toEqual([target]);
    expect(items[target].purgeReason).toBe('retention_expired');
    expect(items[uuidFor(0)].purgedAt).toBeUndefined();
  });
});
