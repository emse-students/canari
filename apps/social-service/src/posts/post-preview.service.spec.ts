/// <reference types="jest" />

import * as crypto from 'crypto';
import { Repository } from 'typeorm';
import { PostPreviewService, decryptPostMedia, pickPreviewMedia } from './post-preview.service';
import type { Post } from './entities/post.entity';
import type { AssociationsService } from '../associations/associations.service';

/**
 * WHAT A SHARED LINK MAY DISCLOSE, ASSERTED RATHER THAN DESCRIBED.
 *
 * This service is the only unauthenticated read of a post in the app, opened on 2026-09-20 so a
 * link shared outside Canari stops previewing as `Publication - Canari`. Everything it refuses is
 * a row somebody could otherwise fish out with a guessed id, and the refusals are the half no
 * feature request will ever exercise - so they are pinned here, one test each.
 */

const UUID = '00000000-0000-4000-8000-0000000000aa';

/** A published association post with no media, the baseline every refusal deviates from. */
function post(overrides: Partial<Post> = {}): Post {
  return {
    id: UUID,
    authorId: 'author-1',
    markdown: 'Le gala arrive',
    associationId: 'asso-1',
    hiddenByModeration: false,
    scheduledAt: null,
    anonymous: false,
    media: [],
    createdAt: new Date('2026-09-01T10:00:00.000Z'),
    updatedAt: new Date('2026-09-02T10:00:00.000Z'),
    ...overrides,
  } as Post;
}

function service(
  row: Post | null,
  association: Record<string, unknown> | Error = {
    name: 'BDE',
    slug: 'bde',
    logoUrl: '/api/media/public/logo-1',
    archived: false,
  }
) {
  const postRepo = {
    findOne: jest.fn(() => Promise.resolve(row)),
  } as unknown as Repository<Post>;
  const associations = {
    findById: jest.fn(() =>
      association instanceof Error ? Promise.reject(association) : Promise.resolve(association)
    ),
  } as unknown as AssociationsService;
  return new PostPreviewService(postRepo, associations);
}

describe('PostPreviewService.getSharePreview - the one predicate', () => {
  it('previews a published association post', async () => {
    const preview = await service(post()).getSharePreview(UUID);
    expect(preview).toMatchObject({
      id: UUID,
      markdown: 'Le gala arrive',
      association: { name: 'BDE', slug: 'bde' },
      image: null,
    });
  });

  it('refuses a personal post - the decision of 2026-09-20, and the whole reason this is narrow', async () => {
    expect(
      await service(post({ associationId: null as unknown as string })).getSharePreview(UUID)
    ).toBeNull();
  });

  it('refuses a moderation-hidden post', async () => {
    expect(await service(post({ hiddenByModeration: true })).getSharePreview(UUID)).toBeNull();
  });

  it('refuses a post scheduled for later, and allows one whose instant has passed', async () => {
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    expect(await service(post({ scheduledAt: future })).getSharePreview(UUID)).toBeNull();
    expect(await service(post({ scheduledAt: past })).getSharePreview(UUID)).not.toBeNull();
  });

  it('refuses a post whose association is archived', async () => {
    const archived = { name: 'BDE', slug: 'bde', logoUrl: null, archived: true };
    expect(await service(post(), archived).getSharePreview(UUID)).toBeNull();
  });

  it('refuses when the association lookup throws rather than propagating a 404', async () => {
    expect(
      await service(post(), new Error('Association not found')).getSharePreview(UUID)
    ).toBeNull();
  });

  it('never reaches Postgres with a non-UUID, which arrives as a syntax error and not a miss', async () => {
    // A direct handle on the jest.fn: reaching it through the Repository cast would be an
    // unbound method reference (typescript/unbound-method).
    const findOne = jest.fn();
    const repo = { findOne } as unknown as Repository<Post>;
    const svc = new PostPreviewService(repo, {} as AssociationsService);
    expect(await svc.getSharePreview('success')).toBeNull();
    expect(findOne).not.toHaveBeenCalled();
  });

  it('carries the stored dimensions so the card reserves the right box', async () => {
    const media = [
      { mediaId: 'm1', key: 'aa', iv: 'bb', mimeType: 'image/webp', width: 2048, height: 1365 },
    ];
    const preview = await service(post({ media })).getSharePreview(UUID);
    expect(preview?.image).toEqual({ width: 2048, height: 1365 });
  });

  it('does not leak the fields a card has no use for', async () => {
    const preview = await service(
      post({ reactions: { u1: 'like' }, comments: [{ body: 'hi' }] } as Partial<Post>)
    ).getSharePreview(UUID);
    expect(preview).not.toHaveProperty('authorId');
    expect(preview).not.toHaveProperty('reactions');
    expect(preview).not.toHaveProperty('comments');
  });
});

describe('pickPreviewMedia', () => {
  it('takes the first IMAGE, which is the one the post itself renders first', () => {
    const picked = pickPreviewMedia([
      { mediaId: 'v', key: 'a', iv: 'b', mimeType: 'video/mp4' },
      { mediaId: 'i1', key: 'a', iv: 'b', mimeType: 'image/webp' },
      { mediaId: 'i2', key: 'a', iv: 'b', mimeType: 'image/png' },
    ]);
    expect(picked?.mediaId).toBe('i1');
  });

  it('skips an entry with no key - there would be nothing to decrypt it with', () => {
    expect(pickPreviewMedia([{ mediaId: 'i1', iv: 'b', mimeType: 'image/webp' }])).toBeNull();
  });

  it('skips an image over the ceiling, because Twitter shows NO card rather than a big one', () => {
    const huge = [
      { mediaId: 'i1', key: 'a', iv: 'b', mimeType: 'image/jpeg', size: 9 * 1024 * 1024 },
    ];
    expect(pickPreviewMedia(huge)).toBeNull();
  });

  it('answers null for a post with no media at all', () => {
    expect(pickPreviewMedia([])).toBeNull();
    expect(pickPreviewMedia(undefined)).toBeNull();
  });
});

describe('decryptPostMedia', () => {
  /**
   * WebCrypto APPENDS the 16-byte GCM tag to the ciphertext and Node's `createDecipheriv` expects
   * it handed over separately. This reproduces the client's output byte for byte - the assertion
   * that matters is not that AES works, but that the tag is where this code believes it is.
   */
  function encryptAsWebCryptoDoes(plaintext: Buffer) {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return {
      ciphertext: Buffer.concat([body, cipher.getAuthTag()]),
      keyHex: key.toString('hex'),
      ivHex: iv.toString('hex'),
    };
  }

  it('round-trips a blob encrypted the way the client encrypts one', () => {
    const plaintext = crypto.randomBytes(4096);
    const { ciphertext, keyHex, ivHex } = encryptAsWebCryptoDoes(plaintext);
    expect(decryptPostMedia(ciphertext, keyHex, ivHex).equals(plaintext)).toBe(true);
  });

  it('throws on a tampered blob rather than returning half a picture', () => {
    const { ciphertext, keyHex, ivHex } = encryptAsWebCryptoDoes(Buffer.from('hello'));
    ciphertext[0] ^= 0xff;
    // The GCM tag is what refuses it, so the message is Node's own - asserted so a future change
    // that swallowed authentication and returned garbage bytes would fail here.
    expect(() => decryptPostMedia(ciphertext, keyHex, ivHex)).toThrow(
      /unable to authenticate data/
    );
  });

  it('refuses a blob shorter than its own authentication tag', () => {
    expect(() => decryptPostMedia(Buffer.alloc(8), '00'.repeat(32), '00'.repeat(12))).toThrow(
      /shorter than its authentication tag/
    );
  });
});

describe('PostPreviewService.readShareableImage', () => {
  it('fails closed, and loudly, when INTERNAL_SECRET is unset', async () => {
    const previous = process.env.INTERNAL_SECRET;
    delete process.env.INTERNAL_SECRET;
    const media = [{ mediaId: 'm1', key: 'aa', iv: 'bb', mimeType: 'image/webp' }];
    try {
      expect(await service(post({ media })).readShareableImage(UUID)).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = previous;
    }
  });

  it('serves nothing for a post the predicate refuses, image or not', async () => {
    const media = [{ mediaId: 'm1', key: 'aa', iv: 'bb', mimeType: 'image/webp' }];
    const refused = service(post({ media, hiddenByModeration: true }));
    expect(await refused.readShareableImage(UUID)).toBeNull();
  });

  /**
   * THE URL ITSELF, BECAUSE NOTHING HERE ASSERTED IT AND THAT IS HOW THE DEFECT SHIPPED.
   *
   * media-service mounts its controllers under a global `/api` prefix; this service fetched
   * `/media/internal/:id` and Express answered its own `Cannot GET` 404. The service logged
   * `preview image <id> answered 404`, which reads as a missing object, so the blob - sitting
   * intact in the bucket - was never suspected. Measured on production 2026-09-22: 11 of 11
   * association posts with an image, every one of them blank in every unfurler.
   *
   * Every refusal above was pinned; the happy path's one outbound call was not.
   */
  it('asks media-service under the /api prefix its controllers are mounted on', async () => {
    const previousSecret = process.env.INTERNAL_SECRET;
    const previousBase = process.env.MEDIA_SERVICE_URL;
    process.env.INTERNAL_SECRET = 'secret';
    process.env.MEDIA_SERVICE_URL = 'http://media-service:3011';
    const realFetch = global.fetch;
    const seen: string[] = [];
    global.fetch = jest.fn((url: unknown) => {
      seen.push(String(url));
      return Promise.resolve({ ok: false, status: 404 } as Response);
    }) as unknown as typeof fetch;

    try {
      const media = [{ mediaId: 'm1', key: 'aa', iv: 'bb', mimeType: 'image/webp' }];
      await service(post({ media })).readShareableImage(UUID);
      expect(seen).toEqual(['http://media-service:3011/api/media/internal/m1']);
    } finally {
      global.fetch = realFetch;
      if (previousSecret === undefined) delete process.env.INTERNAL_SECRET;
      else process.env.INTERNAL_SECRET = previousSecret;
      if (previousBase === undefined) delete process.env.MEDIA_SERVICE_URL;
      else process.env.MEDIA_SERVICE_URL = previousBase;
    }
  });
});
