import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { PublicController } from './public.controller';
import { AssociationsService } from '../associations/associations.service';
import { ProductsService } from '../associations/products.service';

describe('PublicController.getCotisantStatus (WP-COT-4, inbound Cercle check)', () => {
  const ORIGINAL_ENV = process.env.CERCLE_API_KEY;

  afterEach(() => {
    process.env.CERCLE_API_KEY = ORIGINAL_ENV;
  });

  function makeController(apiKey = 'test-cercle-key') {
    process.env.CERCLE_API_KEY = apiKey;
    const associations = {} as AssociationsService;
    // Keep a direct handle on the jest.fn: referencing it through the ProductsService
    // cast would be an unbound method reference (typescript/unbound-method).
    const getCotisantStatusBySlug = jest.fn(() =>
      Promise.resolve({ isCotisant: true, tier: null, expiresAt: null })
    );
    const products = { getCotisantStatusBySlug } as unknown as ProductsService;
    const controller = new PublicController(associations, products);
    return { controller, getCotisantStatusBySlug };
  }

  it('rejects a missing x-api-key header', async () => {
    const { controller } = makeController();
    await expect(
      controller.getCotisantStatus('bde', 'user1', undefined as unknown as string)
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects a wrong x-api-key header', async () => {
    const { controller } = makeController();
    await expect(controller.getCotisantStatus('bde', 'user1', 'wrong-key')).rejects.toThrow(
      ForbiddenException
    );
  });

  it('rejects every request when CERCLE_API_KEY is unset (empty string never matches)', async () => {
    const { controller } = makeController('');
    await expect(controller.getCotisantStatus('bde', 'user1', '')).rejects.toThrow(
      ForbiddenException
    );
  });

  it('rejects a missing assoSlug or sub even with a valid key', async () => {
    const { controller } = makeController();
    await expect(controller.getCotisantStatus('', 'user1', 'test-cercle-key')).rejects.toThrow(
      BadRequestException
    );
    await expect(controller.getCotisantStatus('bde', '', 'test-cercle-key')).rejects.toThrow(
      BadRequestException
    );
  });

  it('delegates to ProductsService.getCotisantStatusBySlug with a valid key and params', async () => {
    const { controller, getCotisantStatusBySlug } = makeController();
    const result = await controller.getCotisantStatus('cercle', 'user1', 'test-cercle-key');

    expect(getCotisantStatusBySlug).toHaveBeenCalledWith('cercle', 'user1');
    expect(result).toEqual({ isCotisant: true, tier: null, expiresAt: null });
  });
});
