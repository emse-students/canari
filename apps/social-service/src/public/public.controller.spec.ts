import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PublicController } from './public.controller';
import { AssociationsService } from '../associations/associations.service';
import { ProductsService } from '../associations/products.service';
import { PosterService } from '../associations/poster.service';
import { PostPreviewService } from '../posts/post-preview.service';

describe('PublicController.getPublishedCarte (WP-CARTO-1, showcase map)', () => {
  function makeController(published: unknown, associations: Record<string, unknown> = {}) {
    const getPublished = jest.fn(() => Promise.resolve(published));
    const poster = { getPublished } as unknown as PosterService;
    return new PublicController(
      associations as unknown as AssociationsService,
      {} as ProductsService,
      poster,
      {} as PostPreviewService
    );
  }

  it('404s when nothing is published, so the showcase simply omits the map', async () => {
    const controller = makeController(null);
    await expect(controller.getPublishedCarte()).rejects.toThrow(NotFoundException);
  });

  it('serves the live map, each card carrying the photo address of its public roster row', async () => {
    const carte = {
      version: 1,
      name: 'Carte 2026',
      units: [
        {
          assoId: 'a1',
          cards: [
            { userId: 'u1', name: 'Ada' },
            { userId: 'u2', name: 'Bob' },
          ],
        },
      ],
    };
    const publicAvatarUrlsFor = jest.fn(() =>
      Promise.resolve(new Map([['a1:u1', '/api/public/members/m1/avatar']]))
    );
    const controller = makeController(carte, { publicAvatarUrlsFor });
    const served = await controller.getPublishedCarte();
    expect(publicAvatarUrlsFor).toHaveBeenCalledWith([
      { associationId: 'a1', userId: 'u1' },
      { associationId: 'a1', userId: 'u2' },
    ]);
    expect(served.units[0].cards.map((c) => c.avatarUrl)).toEqual([
      '/api/public/members/m1/avatar',
      // Bob left the association: no longer on a public roster, so no public photo.
      null,
    ]);
    expect(served.name).toBe('Carte 2026');
  });
});

describe("PublicController.getMemberAvatar (a public roster row's photo)", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function makeRes() {
    const res = {
      headers: {} as Record<string, unknown>,
      statusCode: 0,
      body: undefined as unknown,
      set: jest.fn((h: Record<string, string>) => Object.assign(res.headers, h)),
      setHeader: jest.fn((k: string, v: unknown) => {
        res.headers[k] = v;
      }),
      status: jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      end: jest.fn(),
      send: jest.fn((b: unknown) => {
        res.body = b;
      }),
    };
    return res;
  }

  function makeController(userId: string | null) {
    const publicMemberUserId = jest.fn(() => Promise.resolve(userId));
    return new PublicController(
      { publicMemberUserId } as unknown as AssociationsService,
      {} as ProductsService,
      {} as PosterService,
      {} as PostPreviewService
    );
  }

  type AvatarRes = Parameters<PublicController['getMemberAvatar']>[2];

  it('answers a bodyless 404, and asks core-service nothing, for a row on no public roster', async () => {
    const controller = makeController(null);
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = makeRes();
    await controller.getMemberAvatar('m-x', undefined, res as unknown as AvatarRes);
    expect(res.statusCode).toBe(404);
    expect(res.send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('relays the photo of the account behind the row, never naming that account to the caller', async () => {
    const controller = makeController('acct-1');
    const fetchSpy = jest.fn((_url: string) =>
      Promise.resolve(
        new Response(new Uint8Array([7, 8, 9]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', etag: '"v1"', 'cache-control': 'no-cache' },
        })
      )
    );
    global.fetch = fetchSpy as unknown as typeof fetch;
    const res = makeRes();
    await controller.getMemberAvatar('m-1', undefined, res as unknown as AvatarRes);
    expect(fetchSpy.mock.calls[0][0]).toMatch(/\/api\/users\/acct-1\/avatar$/);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['etag']).toBe('"v1"');
    expect(res.body).toEqual(Buffer.from([7, 8, 9]));
  });

  it('passes a 304 (unchanged) through bodyless, with its ETag', async () => {
    const controller = makeController('acct-1');
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
    ) as unknown as typeof fetch;
    const res = makeRes();
    await controller.getMemberAvatar('m-1', '"v1"', res as unknown as AvatarRes);
    expect(res.statusCode).toBe(304);
    expect(res.headers['etag']).toBe('"v1"');
    expect(res.send).not.toHaveBeenCalled();
  });

  /** "Nobody" and "no photo" are one fact from outside, so not even a header tells them apart. */
  it('answers a row on no roster and a member with no photo with the same bodyless 404', async () => {
    const unknown = makeRes();
    await makeController(null).getMemberAvatar('m-x', undefined, unknown as unknown as AvatarRes);

    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 404,
          headers: { 'cache-control': 'public, max-age=600', 'content-type': 'text/plain' },
        })
      )
    ) as unknown as typeof fetch;
    const noPhoto = makeRes();
    await makeController('acct-1').getMemberAvatar(
      'm-1',
      undefined,
      noPhoto as unknown as AvatarRes
    );

    expect(unknown.statusCode).toBe(404);
    expect(noPhoto.statusCode).toBe(404);
    expect(noPhoto.headers).toEqual(unknown.headers);
    expect(unknown.headers).toEqual({ 'Cache-Control': 'public, max-age=600' });
    expect(unknown.send).not.toHaveBeenCalled();
    expect(noPhoto.send).not.toHaveBeenCalled();
  });

  /**
   * NO THROTTLE ON THE RELAY, AND THAT IS PINNED. A roster or a carte draws a hundred faces and
   * more, and the showcase's server-side proxy brings every visitor from one address: a per-address
   * bucket would turn its photos into initials, and a throttler's refusal is a JSON body handed to
   * an `<img>`.
   */
  it('carries no guard at all, so no throttle can refuse a face', () => {
    const proto = PublicController.prototype as unknown as Record<string, object>;
    const handler = proto['getMemberAvatar'];
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
  });

  it('answers 502 no-store when core-service does not answer, so nothing remembers the outage', async () => {
    const controller = makeController('acct-1');
    global.fetch = jest.fn(() =>
      Promise.reject(new Error('ECONNREFUSED'))
    ) as unknown as typeof fetch;
    const res = makeRes();
    await controller.getMemberAvatar('m-1', undefined, res as unknown as AvatarRes);
    expect(res.statusCode).toBe(502);
    expect(res.headers['Cache-Control']).toBe('no-store');
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

  /**
   * THE LISTING OF RECENT POSTS IS CLOSED (owner, 2026-11-02). One shared link previews one post;
   * a list of the newest ones is a feed, and the feed needs a session. Asserted on the routing
   * metadata, so a route re-added under any method name fails here.
   */
  it('serves no listing of posts without an account - only the single-post preview routes', () => {
    const proto = PublicController.prototype as unknown as Record<string, object>;
    const paths = Object.getOwnPropertyNames(PublicController.prototype)
      .map((name) => Reflect.getMetadata(PATH_METADATA, proto[name]) as string | undefined)
      .filter((path): path is string => typeof path === 'string' && path.startsWith('posts'));
    expect(paths.sort()).toEqual(['posts/:postId/preview', 'posts/:postId/preview-image']);
  });
});
