/// <reference types="jest" />
import { FormsService } from './forms.service';
import { questionImageUrl } from './form-item-images.service';

/**
 * A QUESTION'S IMAGE, as `FormsService` hands it to `FormItemImagesService`: what each write claims
 * and what it releases. The SQL of the claim and the release runs against PostgreSQL in
 * `form-item-images.integration.spec.ts`; this is the wiring around it.
 */
describe("FormsService - a question's image", () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const item = (id: string, mediaId?: string) => ({
    id,
    label: id,
    type: 'short_text',
    required: false,
    ...(mediaId ? { imageUrl: questionImageUrl(mediaId) } : {}),
  });

  function makeService(stored: Record<string, unknown> = {}) {
    const tx = {
      save: jest.fn((_e: unknown, row: any) => Promise.resolve({ id: 'f-new', ...row })),
    };
    const form: any = {
      id: 'f1',
      ownerId: 'alice',
      associationId: null,
      anonymous: false,
      isPublic: false,
      items: [],
      ...stored,
    };
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve(form)),
      create: jest.fn((row: any) => row),
      save: jest.fn((row: any) => Promise.resolve(row)),
      manager: {
        transaction: jest.fn((fn: (m: unknown) => unknown) => fn(tx)),
      },
    };
    const images = {
      claimForSave: jest.fn((_m: unknown, items: any[]) =>
        Promise.resolve(
          [...new Set(items.map((i) => i.imageUrl).filter(Boolean))].map((u: string) =>
            u.slice(-36)
          )
        )
      ),
      bindToForm: jest.fn(() => Promise.resolve()),
      releaseUncited: jest.fn(() => Promise.resolve()),
    };
    const service = new FormsService(
      formRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { enabled: () => false } as any,
      images as any
    );
    // The checks unrelated to images, each pinned by its own spec.
    for (const name of [
      'assertKindMayPrice',
      'assertPaidFormAssociationReady',
      'assertCotisationConfigValid',
    ]) {
      jest.spyOn(service as any, name).mockResolvedValue(undefined);
    }
    return { service, formRepo, images, tx, form };
  }

  it('creates a form with no image as before - no transaction, nothing claimed', async () => {
    const { service, formRepo, images } = makeService();
    await service.create({ title: 'T', ownerId: 'alice', items: [item('q1')] } as any);
    expect(formRepo.manager.transaction).not.toHaveBeenCalled();
    expect(images.claimForSave).not.toHaveBeenCalled();
  });

  it('claims at create in the saving transaction, then binds the images to the new form', async () => {
    const { service, images, tx } = makeService();
    const saved = await service.create({
      title: 'T',
      ownerId: 'alice',
      // A duplicated question cites its source's image: one claim, one id.
      items: [item('q1', A), item('q1-copy', A)],
    } as any);
    expect(images.claimForSave).toHaveBeenCalledWith(tx, expect.any(Array), null, 'alice');
    expect(images.bindToForm).toHaveBeenCalledWith(tx, [A], 'f-new');
    expect(saved.id).toBe('f-new');
  });

  it('claims on edit for this form, and releases the image a replace dropped', async () => {
    const { service, images, tx } = makeService({ items: [item('q1', A)] });
    await service.update('f1', { items: [item('q1', B)] } as any, 'bob', true);
    // A global admin here; a co-manager's right is `assertFormManager`'s own spec.
    expect(images.claimForSave).toHaveBeenCalledWith(tx, expect.any(Array), 'f1', 'bob');
    expect(images.releaseUncited).toHaveBeenCalledWith([A], 'question edited');
  });

  it('releases nothing while a duplicated question still cites the image', async () => {
    const { service, images } = makeService({ items: [item('q1', A), item('q1-copy', A)] });
    await service.update('f1', { items: [item('q1-copy', A)] } as any, 'alice', false);
    expect(images.releaseUncited).not.toHaveBeenCalled();
  });

  it('releases a removed image even when the edit cites none any more', async () => {
    const { service, images, formRepo } = makeService({ items: [item('q1', A)] });
    await service.update('f1', { items: [item('q1')] } as any, 'alice', false);
    expect(formRepo.manager.transaction).toHaveBeenCalled();
    expect(images.releaseUncited).toHaveBeenCalledWith([A], 'question edited');
  });

  it("hands a deleted form's images to the release, which keeps an archived form's", async () => {
    const { service, images, formRepo } = makeService({ items: [item('q1', A)] });
    formRepo.manager.createQueryBuilder = jest.fn(() => {
      const qb: any = {
        update: () => qb,
        delete: () => qb,
        from: () => qb,
        set: () => qb,
        where: () => qb,
        andWhere: () => qb,
        select: () => qb,
        getQuery: () => 'SELECT 1',
        execute: () => Promise.resolve({ affected: 1 }),
      };
      return qb;
    });
    await service.delete('f1', 'alice', false);
    expect(images.releaseUncited).toHaveBeenCalledWith([A], 'form deleted');
  });
});
