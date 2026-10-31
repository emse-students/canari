import { ForbiddenException } from '@nestjs/common';
import { FormsService } from './forms.service';

/**
 * A FORM OF A LIST OR AN INSTITUTION IS NEVER GIVEN A PRICE (owner, 2026-10-31) - and a form that
 * already carries one is left readable and editable, never rewritten.
 */
describe('FormsService - the price of a form of a kind that sells nothing', () => {
  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'f1',
    ownerId: 'u1',
    associationId: 'a1',
    anonymous: false,
    title: 'Inscription',
    basePrice: 0,
    requiresPayment: false,
    priceMatrix: null,
    submitCondition: null,
    items: [{ id: 'q1', label: 'Nom', required: true, type: 'short_text' }],
    ...over,
  });

  function makeService(kind: 'association' | 'list' | 'institution', form = stored()) {
    const formRepo: any = {
      findOne: jest.fn(() => Promise.resolve(form)),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
      create: jest.fn((x: unknown) => x),
    };
    const associations: any = {
      isMember: jest.fn(() => Promise.resolve(true)),
      kindOf: jest.fn(() => Promise.resolve(kind)),
      assertPaymentsReady: jest.fn(() => Promise.resolve()),
      mayAct: jest.fn(() => Promise.resolve(true)),
    };
    const service = new FormsService(
      formRepo,
      {} as any,
      {} as any,
      { get: jest.fn() } as any,
      associations,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );
    jest.spyOn(service as any, 'assertFormManager').mockResolvedValue(form);
    jest.spyOn(service as any, 'assertCotisationConfigValid').mockResolvedValue(undefined);
    return { service, formRepo, associations };
  }

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      title: 'Inscription',
      ownerId: 'u1',
      associationId: 'a1',
      basePrice: 0,
      currency: 'eur',
      items: [{ id: 'q1', label: 'Nom', required: true, type: 'short_text' }],
      ...over,
    }) as any;

  it.each(['list', 'institution'] as const)(
    'refuses a priced form created for a %s, typed 403, nothing saved',
    async (kind) => {
      const { service, formRepo } = makeService(kind);
      const attempt = service.create(dto({ basePrice: 500 }), false);
      await expect(attempt).rejects.toBeInstanceOf(ForbiddenException);
      await expect(attempt).rejects.toMatchObject({
        response: { code: 'ASSOCIATION_KIND_DOES_NOT_SELL' },
      });
      expect(formRepo.save).not.toHaveBeenCalled();
    }
  );

  it('refuses a price grid and a payment switch on a list just the same', async () => {
    const { service } = makeService('list');
    await expect(
      service.create(dto({ priceMatrix: { dimensions: [], cells: { a: 100 } } }), false)
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.create(dto({ requiresPayment: true }), false)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });

  it('lets a free form of a list be created, without even asking its kind of a free form twice', async () => {
    const { service, formRepo } = makeService('list');
    await service.create(dto(), false);
    expect(formRepo.save).toHaveBeenCalledTimes(1);
  });

  it('still lets an association price its forms', async () => {
    const { service, formRepo } = makeService('association');
    await service.create(dto({ basePrice: 500 }), false);
    expect(formRepo.save).toHaveBeenCalledTimes(1);
  });

  it('refuses to PUT a price on a free form of a list', async () => {
    const { service, formRepo } = makeService('list');
    await expect(service.update('f1', dto({ basePrice: 300 }), 'u1', false)).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(formRepo.save).not.toHaveBeenCalled();
  });

  it('leaves a form that already has a price editable while its price fields are untouched', async () => {
    const { service, formRepo } = makeService('list', stored({ basePrice: 500 }));
    await service.update('f1', dto({ basePrice: 500, title: 'Nouveau titre' }), 'u1', false);
    expect(formRepo.save).toHaveBeenCalledTimes(1);
  });

  it('refuses to CHANGE the price of a form of a list, even one that already had one', async () => {
    const { service } = makeService('list', stored({ basePrice: 500 }));
    await expect(service.update('f1', dto({ basePrice: 900 }), 'u1', false)).rejects.toBeInstanceOf(
      ForbiddenException
    );
  });
});
