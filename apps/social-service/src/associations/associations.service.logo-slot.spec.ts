import { AssociationsService } from './associations.service';
import type { Association } from './entities/association.entity';

/**
 * WHICH COLUMN A LOGO UPLOAD WRITES.
 *
 * A promo list can run two themes at once, so it carries `name2` and `logoMediaId2` beside `name`
 * and `logoMediaId`. Every half of the second one existed - column, DTO, public projection,
 * frontend type, detail-page rendering - and there was NO WAY TO SET IT: `setLogoFromUpload` only
 * ever wrote the primary slot, and the blank-to-NULL normalisation on update meant the value could
 * only be cleared. The feature could be turned off and never on (user, 2026-09-22).
 *
 * The slot is a parameter on the ONE implementation rather than a second method, because the
 * ceiling, the mime allowlist, the media upload and the deletion of what it replaces are the same
 * for both - only the column differs. That is exactly what these tests pin: same validation, same
 * replacement, different column, and NO cross-writing in either direction.
 *
 * `logoUrl` belongs to the primary slot alone. It exists to carry a `?v=` cache-buster for the
 * logo every tile in the app renders; the second is read from its media id, which changes on every
 * upload and is therefore its own buster. A second slot writing `logoUrl` would repoint every
 * association tile at the list's alternate theme.
 */
/** A real uuid: `findById` refuses anything else before it reaches the repository. */
const ID = '11111111-1111-4111-8111-111111111111';

function makeService(seed: Partial<Association>) {
  const row = { id: ID, name: 'l1', slug: 'l1', updatedAt: new Date(0), ...seed } as Association;

  const assoRepo = {
    findOne: jest.fn(() => Promise.resolve(row)),
    update: jest.fn((_id: string, patch: Partial<Association>) => {
      Object.assign(row, patch);
      return Promise.resolve({ affected: 1 });
    }),
  };
  const redis = { deleteByPattern: jest.fn(() => Promise.resolve()) };

  // POSITIONAL, AND THIRTEEN LONG - keep aligned with the constructor in `associations.service.ts`.
  const service = new AssociationsService(
    assoRepo as never, // assoRepo
    undefined as never, // memberRepo
    undefined as never, // calendarRepo
    undefined as never, // coOwnerRepo
    undefined as never, // docRepo
    undefined as never, // reviewerGrantRepo
    undefined as never, // postRepo
    undefined as never, // formRepo
    undefined as never, // productRepo
    redis as never, // redis
    undefined as never, // httpService
    undefined as never, // notifications
    undefined as never // userTagService
  );

  // The media round-trip and the best-effort delete are the parts that need a network; both are
  // stubbed so these tests are about the COLUMN and nothing else.
  // `findById` is the existence guard both entry points open with, and it reaches `memberRepo`,
  // `postRepo` and the rest. It is not what these tests are about.
  (service as never as Record<string, unknown>).findById = jest.fn(() => Promise.resolve(row));

  const deleted: string[] = [];
  (service as never as Record<string, unknown>).uploadLogoToMedia = jest.fn(() =>
    Promise.resolve('media-new')
  );
  (service as never as Record<string, unknown>).deleteMediaBestEffort = jest.fn((id: string) => {
    deleted.push(id);
    return Promise.resolve();
  });
  (service as never as Record<string, unknown>).invalidatePostListCaches = jest.fn(() =>
    Promise.resolve()
  );
  return { service, row, deleted };
}

const file = { buffer: Buffer.from([1]), mimetype: 'image/png', size: 10 };
const auth = 'Bearer t';

describe('AssociationsService logo slots', () => {
  it('writes the primary column and its cache-busted url by default', async () => {
    const { service, row } = makeService({ logoMediaId: 'media-old', logoUrl: '/old' });
    await service.setLogoFromUpload(ID, file, auth);
    expect(row.logoMediaId).toBe('media-new');
    expect(row.logoUrl).toContain('/api/media/public/media-new');
    expect(row.logoMediaId2).toBeUndefined();
  });

  it('writes the second column and leaves the primary logo and its url untouched', async () => {
    const { service, row } = makeService({ logoMediaId: 'media-primary', logoUrl: '/primary' });
    await service.setLogoFromUpload(ID, file, auth, 'second');
    expect(row.logoMediaId2).toBe('media-new');
    expect(row.logoMediaId).toBe('media-primary');
    expect(row.logoUrl).toBe('/primary');
  });

  it('deletes the object the SAME slot held, never the other one', async () => {
    const { service, deleted } = makeService({
      logoMediaId: 'media-primary',
      logoMediaId2: 'media-second',
    });
    await service.setLogoFromUpload(ID, file, auth, 'second');
    expect(deleted).toEqual(['media-second']);
  });

  it('clears the second column without clearing the primary url', async () => {
    const { service, row, deleted } = makeService({
      logoMediaId: 'media-primary',
      logoUrl: '/primary',
      logoMediaId2: 'media-second',
    });
    await service.clearStoredLogo(ID, auth, 'second');
    expect(row.logoMediaId2).toBeNull();
    expect(row.logoMediaId).toBe('media-primary');
    expect(row.logoUrl).toBe('/primary');
    expect(deleted).toEqual(['media-second']);
  });

  it('clears both primary columns together', async () => {
    const { service, row } = makeService({
      logoMediaId: 'media-primary',
      logoUrl: '/primary',
      logoMediaId2: 'media-second',
    });
    await service.clearStoredLogo(ID, auth, 'primary');
    expect(row.logoMediaId).toBeNull();
    expect(row.logoUrl).toBeNull();
    expect(row.logoMediaId2).toBe('media-second');
  });

  it('applies the same ceiling and mime allowlist to the second slot', async () => {
    // The validation is shared, so a slot cannot become a way around it.
    const { service } = makeService({});
    await expect(
      service.setLogoFromUpload(ID, { ...file, size: 3 * 1024 * 1024 }, auth, 'second')
    ).rejects.toThrow('Logo must be at most 2097152 bytes');
    await expect(
      service.setLogoFromUpload(ID, { ...file, mimetype: 'image/gif' }, auth, 'second')
    ).rejects.toThrow('Logo must be JPEG, PNG, or WebP');
  });
});
