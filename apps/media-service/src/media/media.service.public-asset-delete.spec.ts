/**
 * `MediaService.removePublicAssets` - the delete social-service calls for a form question's image
 * no form cites any more. It takes ids from another service, so what it REFUSES is the point: only
 * an object stored as a public asset is deleted, whatever else the caller names.
 */
import { MediaService } from './media.service';

const PUBLIC = '11111111-1111-4111-8111-111111111111';
const PRIVATE = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '33333333-3333-4333-8333-333333333333';
const GONE = '44444444-4444-4444-8444-444444444444';
const FORM_FILE = '55555555-5555-4555-8555-555555555555';

type Entry = Record<string, unknown>;

function serviceWith(items: Record<string, Entry>) {
  const service = Object.create(MediaService.prototype) as MediaService;
  const deletedBlobs: string[] = [];
  const internals = service as unknown as Record<string, unknown>;
  internals.meta = { items };
  internals.storage = {
    delete: (id: string) => {
      deletedBlobs.push(id);
      return Promise.resolve();
    },
  };
  internals.persistMetadata = jest.fn(() => Promise.resolve());
  internals.logger = { warn: jest.fn(), log: jest.fn() };
  return { service, deletedBlobs, items };
}

describe('MediaService.removePublicAssets', () => {
  it('deletes a public asset and leaves a manual_delete tombstone', async () => {
    const { service, deletedBlobs, items } = serviceWith({
      [PUBLIC]: { createdAt: 1, lastAccessAt: 2, publicAsset: true, contentType: 'image/webp' },
    });
    expect(await service.removePublicAssets([PUBLIC])).toEqual({
      deleted: [PUBLIC],
      refused: [],
    });
    expect(deletedBlobs).toEqual([PUBLIC]);
    expect(items[PUBLIC]).toMatchObject({ purgeReason: 'manual_delete', createdAt: 1 });
    expect(items[PUBLIC].publicAsset).toBeUndefined();
  });

  it('refuses a private object, a form file, an unindexed id and a non-uuid, touching no blob', async () => {
    const { service, deletedBlobs } = serviceWith({
      [PRIVATE]: { createdAt: 1, lastAccessAt: 1, retentionClass: 'ephemeral' },
      [FORM_FILE]: { createdAt: 1, lastAccessAt: 1, retentionClass: 'form-file' },
    });
    const out = await service.removePublicAssets([PRIVATE, FORM_FILE, UNKNOWN, 'constructor']);
    expect(out.deleted).toEqual([]);
    expect(out.refused).toEqual([PRIVATE, FORM_FILE, UNKNOWN, 'constructor']);
    expect(deletedBlobs).toEqual([]);
  });

  it('answers deleted for an id already tombstoned, keeping the tombstone as it was', async () => {
    const tomb = { createdAt: 1, lastAccessAt: 1, purgedAt: 5, purgeReason: 'retention_expired' };
    const { service, deletedBlobs, items } = serviceWith({ [GONE]: { ...tomb } });
    expect(await service.removePublicAssets([GONE])).toEqual({ deleted: [GONE], refused: [] });
    expect(deletedBlobs).toEqual([]);
    expect(items[GONE]).toEqual(tomb);
  });
});
