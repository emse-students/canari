import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import * as crypto from 'crypto';
import { Repository } from 'typeorm';
import { Post } from './entities/post.entity';
import { AssociationsService } from '../associations/associations.service';
import { mediaUrl } from '../internal/service-urls';

/**
 * WHAT A SHARED `/posts/:id` LINK MAY DISCLOSE TO SOMEBODY WITH NO CANARI SESSION.
 *
 * WHY THIS EXISTS AT ALL. `GET /api/posts/:id` is behind `NginxAuthGuard` + `FeedAudienceGuard`
 * since 2026-09-10, and that gate is correct - the social feed is for ICM students. But the head
 * injector (`frontend/src/hooks.server.ts`) has no session either, so every post link shared into
 * a conversation outside Canari previewed as the bare shell: `Publication - Canari`, the site
 * logo, one generic sentence. Measured on production 2026-09-20 in `frontend-ssr`'s own log -
 * **22 `[SEO] .../api/posts/<id> answered 401` lines in 72 hours, and `sitemap: ... + 0 posts` on
 * every build**. The enricher had never once succeeded there.
 *
 * SO THE GATE IS NOT WIDENED; A NARROWER DOOR IS OPENED BESIDE IT. This service answers for
 * ASSOCIATION posts only, which is already the line the sitemap draws and for the same reason: an
 * association's post is a communication its authors want carried, a student's personal post is
 * not something to hand to whoever holds a URL. A personal post keeps the generic card, and
 * nothing here can widen that - {@link PostPreviewService.findShareable} is the ONE predicate, and
 * both the JSON preview and the image bytes go through it.
 *
 * WHAT IT REFUSES, each of these being a row somebody could otherwise fish out with a guessed id:
 * a post whose association is archived, a moderation-hidden post, and a scheduled post before its
 * publication instant. Reactions, comments, poll results, mentions and the author's user id are
 * not in the payload at all - a preview card needs none of them, and the cheapest way not to leak
 * a field is not to select it.
 */
export interface PostSharePreview {
  id: string;
  /** The post's own text, unrendered. The head injector is what decides how to shorten it. */
  markdown: string;
  createdAt: string;
  updatedAt: string;
  association: { name: string; slug: string; logoUrl: string | null };
  /**
   * The post's first image, when it has one an unfurler can be offered, else null.
   *
   * Only the dimensions travel: the bytes are served by
   * {@link PostPreviewService.readShareableImage} on their own URL, because an unfurler fetches
   * `og:image` as a separate request and a base64 blob in a `<head>` is not something any of them
   * read. The numbers matter on their own - `og:image:width`/`height` are what stop a card
   * reserving a box the image never fills.
   */
  image: { width: number | null; height: number | null } | null;
}

/** The decrypted bytes of a post's preview image, ready to be sent. */
export interface PostPreviewImage {
  data: Buffer;
  contentType: string;
}

/** One media entry as the `posts.images` jsonb column stores it. */
interface StoredPostMedia {
  mediaId?: string;
  key?: string;
  iv?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
}

/**
 * The ceiling above which a post's own photo is not offered as `og:image`.
 *
 * Not a guess at what the bytes cost us - they are served once and cached at the edge - but at
 * what the consumers accept: Twitter refuses an image over 5 MB outright and then shows no card at
 * all, which is worse than the association logo it would otherwise fall back to. The client
 * compresses a post image to 2048px at 0.92 (`IMAGE_COMPRESS_PRESETS.post`), so this ceiling is
 * far above anything the app produces today; it exists for the rows that predate that preset.
 */
const MAX_PREVIEW_IMAGE_BYTES = 5 * 1024 * 1024;

/** AES-GCM authentication tag length, in bytes. WebCrypto appends it to the ciphertext. */
const GCM_TAG_BYTES = 16;

/** How long a service-to-service ciphertext fetch may take before the preview gives up on it. */
const MEDIA_FETCH_TIMEOUT_MS = 4000;

/**
 * Decrypts one post media blob.
 *
 * The client encrypts with `crypto.subtle.encrypt({ name: 'AES-GCM' }, ...)`, which returns the
 * ciphertext with its 16-byte authentication tag APPENDED - a detail WebCrypto hides and Node's
 * `createDecipheriv` does not: it wants the tag handed to `setAuthTag` and the body without it.
 * Splitting them here is the whole difference between this working and every call dying on
 * `Unsupported state or unable to authenticate data`.
 *
 * The key and IV are hex, matching `frontend/src/lib/mediaCrypto.ts` - the format is stated in
 * exactly these two places and nowhere in between.
 */
export function decryptPostMedia(ciphertext: Buffer, keyHex: string, ivHex: string): Buffer {
  if (ciphertext.length <= GCM_TAG_BYTES) {
    throw new Error('ciphertext shorter than its authentication tag');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(keyHex, 'hex'),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES));
  return Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES)),
    decipher.final(),
  ]);
}

/**
 * Picks the media entry a link preview should show, or null when the post has none to offer.
 *
 * The FIRST image, not the largest or the last: it is the one the post itself renders first, so
 * the card and the page agree on what the post looks like. A video, a PDF or an audio note is not
 * a preview image and is skipped rather than served under a lying content type.
 */
export function pickPreviewMedia(media: unknown): StoredPostMedia | null {
  if (!Array.isArray(media)) return null;
  for (const entry of media as StoredPostMedia[]) {
    if (!entry?.mediaId || !entry.key || !entry.iv) continue;
    if (!entry.mimeType?.startsWith('image/')) continue;
    if (typeof entry.size === 'number' && entry.size > MAX_PREVIEW_IMAGE_BYTES) continue;
    return entry;
  }
  return null;
}

/** Reads association posts, and only those, for the unauthenticated link-preview surface. */
@Injectable()
export class PostPreviewService {
  private readonly logger = new Logger(PostPreviewService.name);

  constructor(
    @InjectRepository(Post) private readonly postRepo: Repository<Post>,
    private readonly associations: AssociationsService
  ) {}

  /**
   * THE ONE PREDICATE. Every route on the public surface resolves its post through this, so what a
   * link discloses is decided once rather than restated per endpoint - the shape that left three
   * disagreeing copies of "not for the public" in the SEO layer until 2026-09-14.
   *
   * Returns null for every refusal, deliberately: a caller with no session cannot act on the
   * difference between "no such post", "not an association post" and "not published yet", and
   * spelling them apart would turn this into an oracle for probing ids.
   */
  private async findShareable(postId: string): Promise<{
    post: Post;
    association: { name: string; slug: string; logoUrl: string | null };
  } | null> {
    // A non-UUID reaches Postgres as a syntax error rather than a miss, which surfaces as a 500.
    if (!isUUID(postId)) return null;

    const post = await this.postRepo.findOne({ where: { id: postId } });
    if (!post) return null;
    if (!post.associationId) return null;
    if (post.hiddenByModeration) return null;
    if (post.scheduledAt && new Date(post.scheduledAt).getTime() > Date.now()) return null;

    // `findById` throws NotFoundException on a miss; here an absent association is one more reason
    // to answer nothing, not an error to propagate to an anonymous caller.
    try {
      const association = await this.associations.findById(post.associationId);
      if (!association || association.archived) return null;
      return {
        post,
        association: {
          name: association.name,
          slug: association.slug,
          logoUrl: association.logoUrl ?? null,
        },
      };
    } catch {
      return null;
    }
  }

  /** The card's text and authorship for one shared post, or null when it may not be previewed. */
  async getSharePreview(postId: string): Promise<PostSharePreview | null> {
    const found = await this.findShareable(postId);
    if (!found) {
      this.logger.debug(`share preview refused for ${postId}`);
      return null;
    }
    const { post, association } = found;
    const media = pickPreviewMedia(post.media);

    return {
      id: post.id,
      markdown: post.markdown ?? '',
      createdAt: new Date(post.createdAt).toISOString(),
      updatedAt: new Date(post.updatedAt).toISOString(),
      association,
      image: media ? { width: media.width ?? null, height: media.height ?? null } : null,
    };
  }

  /**
   * The decrypted bytes of a shared post's first image, or null when there is nothing to serve.
   *
   * It fetches the ciphertext from media-service over the Docker network with `X-Internal-Secret`
   * and decrypts it here, because the key lives in the post row and nowhere else: media-service
   * holds the blob and has never held the CEK. That asymmetry is why this cannot be one more
   * `/media/public/:id` - the blob is not public, the DECISION to publish it is, and that decision
   * is a property of the post.
   */
  async readShareableImage(postId: string): Promise<PostPreviewImage | null> {
    const found = await this.findShareable(postId);
    if (!found) return null;

    const media = pickPreviewMedia(found.post.media);
    if (!media) return null;

    const secret = process.env.INTERNAL_SECRET?.trim();
    if (!secret) {
      // Fails closed, and accuses: a deployment that forgot the secret otherwise looks exactly
      // like a post with no photo, which is the failure nobody goes looking for.
      this.logger.error('INTERNAL_SECRET is unset - post preview images cannot be served');
      return null;
    }

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), MEDIA_FETCH_TIMEOUT_MS);
    try {
      const url = mediaUrl(`media/internal/${encodeURIComponent(media.mediaId!)}`);
      const res = await fetch(url, {
        headers: { 'x-internal-secret': secret },
        signal: abort.signal,
      });
      if (!res.ok) {
        // NAMES THE URL, BECAUSE A 404 HAS TWO AUTHORS AND THIS LINE CREDITED THE WRONG ONE.
        // `preview image <id> answered 404` reads as "media-service holds no such object", and for
        // two days it meant "Express has no such route" - the request was missing media-service's
        // global `/api` prefix, and the blob was intact throughout. A status alone cannot separate
        // this service's own NotFoundException from the framework's unknown-route handler; the
        // path asked for can, and it is the one thing the reader cannot reconstruct.
        this.logger.warn(`preview image ${media.mediaId} answered ${res.status} for ${url}`);
        return null;
      }
      const ciphertext = Buffer.from(await res.arrayBuffer());
      if (ciphertext.length > MAX_PREVIEW_IMAGE_BYTES + GCM_TAG_BYTES) {
        this.logger.warn(`preview image ${media.mediaId} is ${ciphertext.length} bytes - refused`);
        return null;
      }
      return {
        data: decryptPostMedia(ciphertext, media.key!, media.iv!),
        contentType: media.mimeType!,
      };
    } catch (err) {
      this.logger.warn(`preview image ${media.mediaId} failed: ${(err as Error)?.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Recent shareable posts, newest first - the sitemap's half of this surface.
   *
   * It applies the SAME eligibility as a single preview, in SQL: an association post, not hidden,
   * published. `/api/posts?feed=associations` used to serve this and has answered 401 to the
   * sitemap builder since the feed gate shipped, which is why production advertised zero post URLs
   * to every crawler for ten days.
   */
  async listShareable(limit: number): Promise<{ id: string; updatedAt: string }[]> {
    const rows = await this.postRepo
      .createQueryBuilder('p')
      .select(['p.id', 'p.updatedAt'])
      .where('p.associationId IS NOT NULL')
      .andWhere('p.hiddenByModeration = false')
      .andWhere('(p.scheduledAt IS NULL OR p.scheduledAt <= NOW())')
      .orderBy('p.createdAt', 'DESC')
      .limit(limit)
      .getMany();

    return rows.map((row) => ({ id: row.id, updatedAt: new Date(row.updatedAt).toISOString() }));
  }
}
