import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PublicController } from './public.controller';
import { AssociationsService } from '../associations/associations.service';
import { ProductsService } from '../associations/products.service';
import { PosterService } from '../associations/poster.service';

describe('PublicController.getPublishedCarte (WP-CARTO-1, showcase map)', () => {
  function makeController(published: unknown) {
    const getPublished = jest.fn(() => Promise.resolve(published));
    const poster = { getPublished } as unknown as PosterService;
    return new PublicController({} as AssociationsService, {} as ProductsService, poster);
  }

  it('404s when nothing is published, so the showcase simply omits the map', async () => {
    const controller = makeController(null);
    await expect(controller.getPublishedCarte()).rejects.toThrow(NotFoundException);
  });

  it('serves the live map as-is', async () => {
    const carte = { version: 1, name: 'Carte 2026', bubbles: [{ assoId: 'a1' }] };
    const controller = makeController(carte);
    await expect(controller.getPublishedCarte()).resolves.toBe(carte);
  });
});

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
    const controller = new PublicController(associations, products, {} as PosterService);
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
