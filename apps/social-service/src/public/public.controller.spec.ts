import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { PublicController } from './public.controller';
import { AssociationsService } from '../associations/associations.service';
import { ProductsService } from '../associations/products.service';
import { PosterService } from '../associations/poster.service';
import { PostPreviewService } from '../posts/post-preview.service';

describe('PublicController.getPublishedCarte (WP-CARTO-1, one live map per space)', () => {
  function makeController(
    published: unknown,
    associations: Record<string, unknown> = {},
    legacy: unknown = null
  ) {
    const getPublished = jest.fn(() => Promise.resolve(published));
    const getSoleLegacyPublished = jest.fn(() => Promise.resolve(legacy));
    const poster = { getPublished, getSoleLegacyPublished } as unknown as PosterService;
    const controller = new PublicController(
      associations as unknown as AssociationsService,
      {} as ProductsService,
      poster,
      {} as PostPreviewService
    );
    return { controller, getPublished, getSoleLegacyPublished };
  }

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

  it('404s when the named space has nothing live, so the showcase simply omits the map', async () => {
    const { controller, getPublished } = makeController(null);
    await expect(controller.getPublishedCarte('ICM:saint-etienne')).rejects.toThrow(
      NotFoundException
    );
    expect(getPublished).toHaveBeenCalledWith({ formation: 'ICM', campus: 'saint-etienne' });
  });

  it('serves the live map of the named space, each card carrying the photo address of its public roster row', async () => {
    const publicAvatarUrlsFor = jest.fn(() =>
      Promise.resolve(new Map([['a1:u1', '/api/public/members/m1/avatar']]))
    );
    const { controller } = makeController(carte, { publicAvatarUrlsFor });
    const served = await controller.getPublishedCarte('ICM:saint-etienne');
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

  it.each([
    ['a value with no colon', 'ICM'],
    ['an unknown formation', 'XYZ:saint-etienne'],
    ['an unknown campus', 'ICM:paris'],
    ['a lower-cased formation', 'icm:saint-etienne'],
    ['three parts', 'ICM:saint-etienne:x'],
    ['a repeated parameter', ['ICM:saint-etienne', 'ISMIN:saint-etienne']],
  ])('refuses %s with the typed 400, before any read', async (_label, value) => {
    const { controller, getPublished } = makeController(carte);
    await expect(controller.getPublishedCarte(value)).rejects.toMatchObject({
      response: { code: 'PUBLIC_SPACE_INVALID' },
    });
    expect(getPublished).not.toHaveBeenCalled();
  });

  it('[LEGACY] serves the one live map to a showcase that names no space', async () => {
    const publicAvatarUrlsFor = jest.fn(() => Promise.resolve(new Map()));
    const { controller, getPublished, getSoleLegacyPublished } = makeController(
      null,
      { publicAvatarUrlsFor },
      carte
    );
    const served = await controller.getPublishedCarte(undefined);
    expect(served.name).toBe('Carte 2026');
    expect(getSoleLegacyPublished).toHaveBeenCalled();
    expect(getPublished).not.toHaveBeenCalled();
  });

  it('[LEGACY] answers a typed 400 with no space when zero or several maps are live, never a guess', async () => {
    const { controller } = makeController(null, {}, null);
    const refusal = controller.getPublishedCarte('');
    await expect(refusal).rejects.toThrow(BadRequestException);
    await expect(controller.getPublishedCarte(undefined)).rejects.toMatchObject({
      response: { code: 'CARTE_PUBLIC_SPACE_REQUIRED' },
    });
  });
});

describe('PublicController - the association directory of one space (owner, 2026-11-08)', () => {
  const rows = [
    { id: 'in', slug: 'in', name: 'In', type: 'association' },
    { id: 'out', slug: 'out', name: 'Out', type: 'association' },
    { id: 'lst', slug: 'lst', name: 'Liste', type: 'list' },
    { id: 'lst-out', slug: 'lst-out', name: 'Liste ailleurs', type: 'list' },
    { id: 'inst-out', slug: 'inst-out', name: 'Etablissement ailleurs', type: 'institution' },
    { id: 'old', slug: 'old', name: 'Old', type: 'association', archived: true },
  ];
  function makeController() {
    const list = jest.fn(() => Promise.resolve(rows));
    // The space's entities of every type, archived ones included (`old`).
    const offeredInSpace = jest.fn(() => Promise.resolve(new Set(['in', 'lst', 'old'])));
    const findBySlug = jest.fn((slug: string) =>
      Promise.resolve(rows.find((r) => r.slug === slug))
    );
    const listMembersPublic = jest.fn(() => Promise.resolve([]));
    const controller = new PublicController(
      { list, offeredInSpace, findBySlug, listMembersPublic } as unknown as AssociationsService,
      {} as ProductsService,
      {} as PosterService,
      {} as PostPreviewService
    );
    return { controller, list, offeredInSpace };
  }

  it('keeps only what the named space offers, a list or an institution like an association (owner, 2026-11-14)', async () => {
    const { controller, offeredInSpace } = makeController();
    const served = await controller.listAssociations(undefined, 'ICM:saint-etienne');
    expect(served.map((a) => a.slug)).toEqual(['in', 'lst', 'old']);
    expect(offeredInSpace).toHaveBeenCalledWith({ formation: 'ICM', campus: 'saint-etienne' });
  });

  it("answers the COMPLETE list without a space - Canari's own sitemap reads it", async () => {
    const { controller, offeredInSpace } = makeController();
    const served = await controller.listAssociations('association', undefined);
    expect(served.map((a) => a.slug)).toEqual(['in', 'out', 'lst', 'lst-out', 'inst-out', 'old']);
    expect(offeredInSpace).not.toHaveBeenCalled();
  });

  it('refuses a malformed space with the typed 400, before any read', async () => {
    const { controller, list } = makeController();
    await expect(controller.listAssociations('association', 'ICM')).rejects.toMatchObject({
      response: { code: 'PUBLIC_SPACE_INVALID' },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('404s an association page the named space does not offer, and serves it without a space', async () => {
    const { controller } = makeController();
    await expect(controller.getBySlug('out', 'ICM:saint-etienne')).rejects.toThrow(
      NotFoundException
    );
    await expect(controller.getBySlug('in', 'ICM:saint-etienne')).resolves.toMatchObject({
      slug: 'in',
    });
    // A list of the space is served; a list or an institution of another space is a 404 too.
    await expect(controller.getBySlug('lst', 'ICM:saint-etienne')).resolves.toMatchObject({
      slug: 'lst',
    });
    await expect(controller.getBySlug('lst-out', 'ICM:saint-etienne')).rejects.toThrow(
      NotFoundException
    );
    await expect(controller.getBySlug('inst-out', 'ICM:saint-etienne')).rejects.toThrow(
      NotFoundException
    );
    // Archived, of the space: still its page (the portail's archived section links it).
    await expect(controller.getBySlug('old', 'ICM:saint-etienne')).resolves.toMatchObject({
      slug: 'old',
    });
    await expect(controller.getBySlug('out', undefined)).resolves.toMatchObject({ slug: 'out' });
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
   * NO THROTTLE ON THE RELAY, AND THAT IS PINNED, at the handler and at the class. The showcase
   * hands `avatarUrl` to the visitor's browser, which asks for every face a carte or a roster draws
   * - a hundred and more, plus each revalidation: the default bucket (20 a minute per address, per
   * replica) would turn one carte render into initials, and a throttler's refusal is a JSON body
   * handed to an `<img>`.
   */
  it('carries no guard at all, so no throttle can refuse a face', () => {
    const proto = PublicController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(GUARDS_METADATA, proto['getMemberAvatar'])).toBeUndefined();
    expect(Reflect.getMetadata(GUARDS_METADATA, PublicController)).toBeUndefined();
  });

  describe('the internal secret on the call to core', () => {
    const saved = process.env.INTERNAL_SECRET;
    afterEach(() => {
      if (saved === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = saved;
    });

    function capture() {
      const fetchSpy = jest.fn((_url: string, _init: { headers: Record<string, string> }) =>
        Promise.resolve(new Response(null, { status: 404 }))
      );
      global.fetch = fetchSpy as unknown as typeof fetch;
      return fetchSpy;
    }

    it('carries x-internal-secret when the secret is set', async () => {
      process.env.INTERNAL_SECRET = 's3cret';
      const fetchSpy = capture();
      await makeController('acct-1').getMemberAvatar(
        'm-1',
        '"v1"',
        makeRes() as unknown as AvatarRes
      );
      expect(fetchSpy.mock.calls[0][1].headers).toEqual({
        'x-internal-secret': 's3cret',
        'If-None-Match': '"v1"',
      });
    });

    it('sends no secret header at all when the secret is unset, never an empty one', async () => {
      delete process.env.INTERNAL_SECRET;
      const fetchSpy = capture();
      await makeController('acct-1').getMemberAvatar(
        'm-1',
        undefined,
        makeRes() as unknown as AvatarRes
      );
      expect(fetchSpy.mock.calls[0][1].headers).toEqual({});
    });
  });

  it('says at warn, accusing core, a status that is neither a photo, a 304 nor a 404', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    global.fetch = jest.fn(() =>
      Promise.resolve(new Response(null, { status: 403 }))
    ) as unknown as typeof fetch;
    const res = makeRes();
    await makeController('acct-1').getMemberAvatar('m-1', undefined, res as unknown as AvatarRes);
    expect(res.statusCode).toBe(403);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[PUBLIC_AVATAR] core refused 403'));
    warn.mockRestore();
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
