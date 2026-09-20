import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PublicController } from './public.controller';
import { AssociationsService } from '../associations/associations.service';
import { ProductsService } from '../associations/products.service';
import { PosterService } from '../associations/poster.service';
import { PostPreviewService } from '../posts/post-preview.service';

describe('PublicController.getPublishedCarte (WP-CARTO-1, showcase map)', () => {
  function makeController(published: unknown) {
    const getPublished = jest.fn(() => Promise.resolve(published));
    const poster = { getPublished } as unknown as PosterService;
    return new PublicController(
      {} as AssociationsService,
      {} as ProductsService,
      poster,
      {} as PostPreviewService
    );
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
    const controller = new PublicController(
      associations,
      products,
      {} as PosterService,
      {} as PostPreviewService
    );
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

describe('PublicController - shared post link previews', () => {
  function makeController(previews: Partial<PostPreviewService>) {
    return new PublicController(
      {} as AssociationsService,
      {} as ProductsService,
      {} as PosterService,
      previews as PostPreviewService
    );
  }

  /**
   * A REFUSAL AND AN ABSENCE MUST LOOK THE SAME FROM OUTSIDE. `PostPreviewService` answers null
   * for a personal post, a hidden one, one not yet published and one whose association is
   * archived; spelling any of those apart from "no such post" would turn a guessed id into a way
   * to ask whether a hidden post exists.
   */
  it('404s on every refusal, indistinguishably from a post that does not exist', async () => {
    const controller = makeController({
      getSharePreview: jest.fn(() => Promise.resolve(null)),
    });
    await expect(controller.getPostPreview('whatever')).rejects.toThrow(NotFoundException);
  });

  it('serves the preview the service resolved, unchanged', async () => {
    const preview = {
      id: 'p1',
      markdown: 'Le gala arrive',
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
      association: { name: 'BDE', slug: 'bde', logoUrl: null },
      image: { width: 2048, height: 1365 },
    };
    const controller = makeController({
      getSharePreview: jest.fn(() => Promise.resolve(preview)),
    });
    await expect(controller.getPostPreview('p1')).resolves.toBe(preview);
  });

  it('404s rather than serving an empty body when there is no image to decrypt', async () => {
    const controller = makeController({
      readShareableImage: jest.fn(() => Promise.resolve(null)),
    });
    const res = { setHeader: jest.fn(), send: jest.fn() };
    await expect(
      controller.getPostPreviewImage(
        'p1',
        res as unknown as Parameters<PublicController['getPostPreviewImage']>[1]
      )
    ).rejects.toThrow(NotFoundException);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('sends the decrypted bytes under their stored content type', async () => {
    const data = Buffer.from([1, 2, 3, 4]);
    const controller = makeController({
      readShareableImage: jest.fn(() => Promise.resolve({ data, contentType: 'image/webp' })),
    });
    const res = { setHeader: jest.fn(), send: jest.fn() };
    await controller.getPostPreviewImage(
      'p1',
      res as unknown as Parameters<PublicController['getPostPreviewImage']>[1]
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'image/webp');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', 4);
    expect(res.send).toHaveBeenCalledWith(data);
  });

  /** The cap exists so an anonymous caller cannot ask for the whole table by widening `?limit=`. */
  it('caps the shareable list whatever the query asks for, and defaults when it asks nothing', async () => {
    const listShareable = jest.fn(() => Promise.resolve([]));
    const controller = makeController({ listShareable });

    await controller.listShareablePosts('99999');
    expect(listShareable).toHaveBeenLastCalledWith(500);

    await controller.listShareablePosts(undefined);
    expect(listShareable).toHaveBeenLastCalledWith(500);

    await controller.listShareablePosts('not-a-number');
    expect(listShareable).toHaveBeenLastCalledWith(500);

    await controller.listShareablePosts('-5');
    expect(listShareable).toHaveBeenLastCalledWith(1);

    await controller.listShareablePosts('42');
    expect(listShareable).toHaveBeenLastCalledWith(42);
  });
});
