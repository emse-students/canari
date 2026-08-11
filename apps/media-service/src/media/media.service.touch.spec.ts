/**
 * `MediaService.touch` - the write that makes the 30-day retention clock mean what it says.
 *
 * The asymmetry these cases are built around: refreshing an entry that did not need it costs
 * nothing, while failing to refresh one deletes somebody's photograph. So the cases that matter
 * are the ones where `touch` is asked to do something it must REFUSE - reviving a tombstone the
 * retention decision already closed, or creating an entry for an id nobody stored.
 */
import { MediaService } from './media.service';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const UUID_PURGED = '33333333-3333-4333-8333-333333333333';

type ServiceInternals = {
  meta: { items: Record<string, { createdAt: number; lastAccessAt: number; purgedAt?: number }> };
  persistMetadata: () => Promise<void>;
};

/**
 * A service with its metadata planted directly and persistence stubbed.
 *
 * `touch` reads and writes only `this.meta` plus one `persistMetadata` call, so the constructor's
 * storage and sweep are irrelevant here - and going through them would make this a test of MinIO.
 */
function serviceWith(items: ServiceInternals['meta']['items']): {
  service: MediaService;
  persisted: () => number;
} {
  const service = Object.create(MediaService.prototype) as MediaService;
  let persistCalls = 0;
  const internals = service as unknown as ServiceInternals;
  internals.meta = { items };
  internals.persistMetadata = () => {
    persistCalls += 1;
    return Promise.resolve();
  };
  return { service, persisted: () => persistCalls };
}

describe('MediaService.touch', () => {
  const OLD = 1_000;

  it('refreshes lastAccessAt for known, live entries', async () => {
    const items = {
      [UUID_A]: { createdAt: OLD, lastAccessAt: OLD },
      [UUID_B]: { createdAt: OLD, lastAccessAt: OLD },
    };
    const { service, persisted } = serviceWith(items);

    expect(await service.touch([UUID_A, UUID_B])).toBe(2);
    expect(items[UUID_A].lastAccessAt).toBeGreaterThan(OLD);
    expect(items[UUID_B].lastAccessAt).toBeGreaterThan(OLD);
    // One write for the whole batch, not one per id.
    expect(persisted()).toBe(1);
  });

  it('leaves createdAt alone - it is the only record of when the object arrived', async () => {
    const items = { [UUID_A]: { createdAt: OLD, lastAccessAt: OLD } };
    const { service } = serviceWith(items);

    await service.touch([UUID_A]);

    expect(items[UUID_A].createdAt).toBe(OLD);
  });

  it('does NOT revive a purged entry', async () => {
    const items = { [UUID_PURGED]: { createdAt: OLD, lastAccessAt: OLD, purgedAt: OLD } };
    const { service, persisted } = serviceWith(items);

    // The blob is gone; the tombstone is what tells every client "expired, ask for a resend".
    // Refreshing it would make the sweep re-evaluate a decision that has already been carried out.
    expect(await service.touch([UUID_PURGED])).toBe(0);
    expect(items[UUID_PURGED].purgedAt).toBe(OLD);
    expect(persisted()).toBe(0);
  });

  it('ignores ids it has never stored rather than creating entries for them', async () => {
    const items = {};
    const { service, persisted } = serviceWith(items);

    expect(await service.touch([UUID_A])).toBe(0);
    expect(Object.keys(items)).toHaveLength(0);
    expect(persisted()).toBe(0);
  });

  it('rejects non-UUID ids, which are the property-key injection vector here', async () => {
    const items = { [UUID_A]: { createdAt: OLD, lastAccessAt: OLD } };
    const { service } = serviceWith(items);

    expect(await service.touch(['__proto__', 'constructor', '../../etc/passwd'])).toBe(0);
    expect(Object.keys(items)).toEqual([UUID_A]);
  });

  it('persists once for a mixed batch, and counts only what it changed', async () => {
    const items = {
      [UUID_A]: { createdAt: OLD, lastAccessAt: OLD },
      [UUID_PURGED]: { createdAt: OLD, lastAccessAt: OLD, purgedAt: OLD },
    };
    const { service, persisted } = serviceWith(items);

    expect(await service.touch([UUID_A, UUID_PURGED, UUID_B, 'nonsense'])).toBe(1);
    expect(persisted()).toBe(1);
  });
});
