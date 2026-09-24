/**
 * MediaController
 *
 * Endpoints:
 *   GET  /media/limits  - The one ceiling, so no client has to be built carrying a copy of it
 *   POST /media/upload  - Receive an encrypted blob, store it, return { mediaId }
 *   GET  /media/:id     - Return the encrypted blob (client decrypts it)
 *   POST /media/touch   - Refresh the retention clock for media the client had cached locally
 *   DELETE /media/:id   - Remove a blob (server-to-server only: valid JWT + X-Internal-Secret)
 *   POST /media/internal/retention-class - classify/release objects (X-Internal-Secret)
 *
 * Authentication: Bearer JWT validated via the shared JWT_SECRET env var.
 * The token carries `sub` (userId). Deletion additionally requires the shared
 * X-Internal-Secret so only social-service (which owns association-admin authz) can
 * remove blobs - a logged-in client cannot delete another association's public assets.
 *
 * Size limit: configurable via MEDIA_MAX_SIZE_MB (default 100 MB, capped at 100 by policy), and
 * published by GET /media/limits so a client never has to carry a build-time copy of it.
 * The service never inspects the ciphertext content.
 */
import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  Res,
  Req,
  Headers,
  UseInterceptors,
  UploadedFile,
  NotFoundException,
  GoneException,
  PayloadTooLargeException,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import sharp from 'sharp';
import {
  MediaService,
  isRetentionClass,
  type MediaStorageStats,
  type RetentionClass,
} from './media.service';
import { assertInternalSecret } from './internal-secret.util';
import { requireUploadedFile, uploadedFileBuffer, uploadedFileMime } from './uploaded-file';

const POLICY_MAX_MEDIA_MB = 100;
const CONFIGURED_MAX_MB = parseInt(process.env.MEDIA_MAX_SIZE_MB ?? '100', 10);
const MAX_BYTES =
  Math.min(
    Number.isFinite(CONFIGURED_MAX_MB) && CONFIGURED_MAX_MB > 0
      ? CONFIGURED_MAX_MB
      : POLICY_MAX_MEDIA_MB,
    POLICY_MAX_MEDIA_MB
  ) *
  1024 *
  1024;
const CHUNK_MAX_BYTES = 50 * 1024 * 1024;

/** Public branding images (association logos); JWT required for upload only. */
const PUBLIC_LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** Browser cache for versioned logo URLs (`?v=` busts on re-upload); server retention is indefinite. */
const PUBLIC_ASSET_CACHE_MAX_AGE_SEC = 365 * 24 * 60 * 60;
const ALLOWED_PUBLIC_LOGO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Upper bound on a single POST /media/touch batch; the client batches well below this. */
const TOUCH_MAX_IDS = 500;

/** Upper bound on a single POST /media/internal/retention-class batch; social-service chunks to it. */
const RETENTION_CLASS_MAX_IDS = 500;

@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(private readonly mediaService: MediaService) {}

  // ---------------------------------------------------------------------------
  // Auth helper - validates the shared HS256 JWT (same secret as chat-gateway)
  // ---------------------------------------------------------------------------
  private verifyToken(req: Request): string {
    const header = req.headers['authorization'] ?? '';
    if (!header.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing Bearer token');
    }
    const token = header.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new UnauthorizedException('JWT_SECRET not configured');
    }

    const parts = token.split('.');
    if (parts.length !== 3) throw new UnauthorizedException('Malformed JWT');

    const [headerB64, payloadB64, sigB64] = parts;
    const toSign = `${headerB64}.${payloadB64}`;

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(toSign);
    const expected = hmac
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    // CONSTANT TIME, because `!==` on an HMAC tells its caller how much of a guess was right.
    // `timingSafeEqual` THROWS on a length mismatch rather than answering false, and a signature of
    // the wrong length is a refusal either way - so the length is checked first and the buffers are
    // built from the same encoding.
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(sigB64, 'utf8');
    if (
      expectedBuf.length !== actualBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, actualBuf)
    ) {
      throw new UnauthorizedException('Invalid JWT signature');
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('JWT expired');
    }

    return payload.sub as string;
  }

  // ---------------------------------------------------------------------------
  // GET /media/limits
  // ---------------------------------------------------------------------------
  /**
   * The upload ceiling, as ONE fact the client asks for rather than one it is built with.
   *
   * ## What was wrong with a build-time number
   *
   * The client refused a file over `VITE_MEDIA_MAX_SIZE_MB`, a Vite variable inlined at BUILD time.
   * Nothing in `build.yml` ever wrote it - it is set only by `scripts/setup-env.sh` on a developer's
   * machine - so every shipped build (web, APK, iOS) used the code default of 100 MB while every
   * server has run on `MEDIA_MAX_SIZE_MB=50`. Measured on the local estate 2026-09-24: 49 MB
   * uploads with `201`, 51 MB is refused with `413 File too large`. A member could therefore pick a
   * 90 MB video, watch the whole of it go up, and be refused at the end - and `client_max_body_size
   * 100m` on nginx, long believed to be the opposing side, never got a say at all.
   *
   * A build-time variable could not have fixed it either, which is the deciding argument: **an
   * installed APK carries whatever value it was built with, and nothing keeps that in step with the
   * box.** Only the box can answer, so the box answers.
   *
   * ## Why no JWT
   *
   * It is global platform configuration, never user-specific - the same shape as
   * `GET /payments/provider`, and declared alongside it in
   * `.github/scripts/tests/auth-request-coverage.test.mjs`. It reveals a number that anybody may
   * discover by attempting one upload.
   *
   * @returns `maxBytes`, measured on the CIPHERTEXT - which is the plaintext plus the 16-byte
   *   AES-GCM tag, the IV travelling beside the blob rather than inside it.
   */
  @Get('limits')
  limits(): { maxBytes: number } {
    return { maxBytes: MAX_BYTES };
  }

  // ---------------------------------------------------------------------------
  // POST /media/upload
  // ---------------------------------------------------------------------------
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES },
      // Store entirely in memory - we pass raw bytes to Garage
      storage: undefined,
    })
  )
  async upload(
    @UploadedFile() file: unknown,
    @Body() body: { retentionClass?: unknown },
    @Req() req: Request
  ): Promise<{ mediaId: string }> {
    const ownerId = this.verifyToken(req);

    let upload: ReturnType<typeof requireUploadedFile>;
    try {
      upload = requireUploadedFile(file);
    } catch {
      // NAMES THE CONFIGURED CEILING, NOT THE POLICY ONE. This said `POLICY_MAX_MEDIA_MB` - 100 -
      // on a service that has always run at 50, so the one line a caller reads when an upload is
      // refused announced a limit twice the real one.
      throw new PayloadTooLargeException(
        `No file provided or file exceeds size limit (${MAX_BYTES} bytes max)`
      );
    }

    // The client names the surface it uploaded from, because it is the only party that knows.
    // Unrecognised values are ignored rather than refused: the field is a retention HINT, an old
    // client sends none at all, and failing an upload over it would break posting outright.
    const retentionClass = isRetentionClass(body?.retentionClass) ? body.retentionClass : undefined;

    const mediaId = await this.mediaService.upload(upload.buffer, ownerId, retentionClass);
    this.logger.log(
      `Stored encrypted blob: ${mediaId} (${upload.size} bytes, retention=${retentionClass ?? 'idle'})`
    );
    return { mediaId };
  }

  // ---------------------------------------------------------------------------
  // POST /media/upload/public - small public image (not ciphertext)
  // ---------------------------------------------------------------------------
  @Post('upload/public')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: PUBLIC_LOGO_MAX_BYTES },
      storage: undefined,
    })
  )
  async uploadPublic(
    @UploadedFile() file: unknown,
    @Req() req: Request
  ): Promise<{ mediaId: string }> {
    this.verifyToken(req);

    let upload: ReturnType<typeof requireUploadedFile>;
    try {
      upload = requireUploadedFile(file);
    } catch {
      throw new PayloadTooLargeException(
        `No file provided or file exceeds ${PUBLIC_LOGO_MAX_BYTES} bytes`
      );
    }
    const mime = uploadedFileMime(upload);
    if (!ALLOWED_PUBLIC_LOGO_MIMES.has(mime)) {
      throw new BadRequestException('Logo must be JPEG, PNG, or WebP');
    }

    // Resize to max 512×512, convert to WebP 90% - logos are always public/unencrypted.
    const compressed = await sharp(upload.buffer)
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 90 })
      .toBuffer();

    const mediaId = await this.mediaService.uploadPublicAsset(compressed, 'image/webp');
    this.logger.log(
      `Stored public asset: ${mediaId} (${upload.size} → ${compressed.length} bytes, webp)`
    );
    return { mediaId };
  }

  // ---------------------------------------------------------------------------  // POST /media/upload/chunk/init
  // ---------------------------------------------------------------------------
  @Post('upload/chunk/init')
  async initChunkedUpload(@Req() req: Request): Promise<{ uploadId: string }> {
    this.verifyToken(req);
    const uploadId = await this.mediaService.initChunkedUpload();
    this.logger.log(`Initialized chunked upload: ${uploadId}`);
    return { uploadId };
  }

  // ---------------------------------------------------------------------------
  // POST /media/upload/chunk/:id
  // ---------------------------------------------------------------------------
  @Post('upload/chunk/:id')
  @UseInterceptors(
    FileInterceptor('chunk', {
      limits: { fileSize: CHUNK_MAX_BYTES }, // Max 50 MB per chunk
      storage: undefined,
    })
  )
  async appendChunk(
    @Param('id') id: string,
    @UploadedFile() file: unknown,
    @Req() req: Request
  ): Promise<{ ok: boolean }> {
    this.verifyToken(req);
    const buffer = uploadedFileBuffer(file);
    await this.mediaService.appendChunk(id, buffer, MAX_BYTES);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // POST /media/upload/chunk/:id/complete
  // ---------------------------------------------------------------------------
  @Post('upload/chunk/:id/complete')
  async completeChunkedUpload(
    @Param('id') id: string,
    @Body() body: { retentionClass?: unknown },
    @Req() req: Request
  ): Promise<{ mediaId: string }> {
    const ownerId = this.verifyToken(req);
    // Same hint as the single-shot upload: a 50 MB+ video posted to the feed is archive too, and
    // the class has to survive the path the file happened to take.
    const retentionClass = isRetentionClass(body?.retentionClass) ? body.retentionClass : undefined;
    const mediaId = await this.mediaService.completeChunkedUpload(
      id,
      MAX_BYTES,
      ownerId,
      retentionClass
    );
    this.logger.log(
      `Completed chunked upload: ${id} -> ${mediaId} (retention=${retentionClass ?? 'idle'})`
    );
    return { mediaId };
  }

  // ---------------------------------------------------------------------------
  // GET /media/public/:id - no JWT (nginx should expose only this prefix publicly)
  // ---------------------------------------------------------------------------
  @Get('public/:id')
  async downloadPublic(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const result = await this.mediaService.downloadPublic(id);
    if (result.status !== 'ok' || !result.data) {
      throw new NotFoundException('Media not found');
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', result.data.length);
    res.setHeader('Cache-Control', `public, max-age=${PUBLIC_ASSET_CACHE_MAX_AGE_SEC}, immutable`);
    res.send(result.data);
  }

  // ---------------------------------------------------------------------------
  // GET /media/internal/storage-stats - what the bucket holds, and why it is that size
  // ---------------------------------------------------------------------------
  /**
   * Reports the object storage bucket's breakdown to an internal caller (the chat-delivery-service
   * admin storage aggregator, WP-DEVICESTORAGE-1's backend counterpart). Not just a total: the
   * fields separate growth from a retention sweep that has stopped working - see
   * {@link MediaService.getStorageStats}.
   * Declared before `internal/:id` so "storage-stats" is matched as a literal segment, not an id.
   */
  @Get('internal/storage-stats')
  async internalStorageStats(
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<MediaStorageStats> {
    assertInternalSecret(internalSecret);
    return this.mediaService.getStorageStats();
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/retention-class - classify or release existing objects
  // ---------------------------------------------------------------------------
  /**
   * Sets (`'archive'`) or clears (`null`) the retention class of objects that already exist.
   *
   * Sole consumer: social-service, which owns the post rows and is therefore the only party that
   * can say an object is still cited by one. It classifies what was uploaded before the class
   * existed, and releases what a deleted post no longer references.
   *
   * X-Internal-Secret and NO user JWT, unlike `POST /media/touch`: the backfill runs at boot with
   * no user in sight, and unlike a touch this can also REMOVE a reason to keep an object - so it
   * is not something a logged-in client may aim at somebody else's id.
   */
  @Post('internal/retention-class')
  async setRetentionClass(
    @Body() body: { mediaIds?: unknown; retentionClass?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ changed: number }> {
    assertInternalSecret(internalSecret);

    const ids = body?.mediaIds;
    if (!Array.isArray(ids)) {
      throw new BadRequestException('mediaIds must be an array');
    }
    // Bounded like the touch batch, and for the same reason: a body is attacker-controlled even
    // behind the internal secret, and an unbounded loop here holds the metadata lock.
    if (ids.length > RETENTION_CLASS_MAX_IDS) {
      throw new BadRequestException(
        `mediaIds must hold at most ${RETENTION_CLASS_MAX_IDS} entries`
      );
    }

    // Null is the RELEASE and has to stay distinguishable from an absent field, so it is checked
    // rather than defaulted: a body that forgot the key must not silently unclassify a batch.
    let retentionClass: RetentionClass | null = null;
    if (body?.retentionClass != null) {
      if (!isRetentionClass(body.retentionClass)) {
        throw new BadRequestException("retentionClass must be 'archive' or null");
      }
      retentionClass = body.retentionClass;
    }

    const changed = await this.mediaService.setRetentionClass(
      ids.filter((id): id is string => typeof id === 'string'),
      retentionClass
    );
    if (changed > 0) {
      this.logger.log(
        `Retention class ${retentionClass ?? 'cleared'} applied to ${changed} object(s)`
      );
    }
    return { changed };
  }

  // ---------------------------------------------------------------------------
  // GET /media/internal/:id - server-to-server ciphertext fetch (X-Internal-Secret)
  // ---------------------------------------------------------------------------
  /**
   * Returns the encrypted blob to an internal caller authenticated by the shared X-Internal-Secret
   * (no user JWT). Sole consumer: chat-delivery-service's `/api/mls/push/media/:id` proxy, which
   * needs the ciphertext to build a rich media notification while the recipient's app is killed
   * (background push has no user token). Same fail-closed secret gate as DELETE. Declared before the
   * catch-all `@Get(':id')` so "internal" is matched as a literal segment, not an id.
   */
  @Get('internal/:id')
  async downloadInternal(
    @Param('id') id: string,
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    assertInternalSecret(internalSecret);

    const result = await this.mediaService.download(id);
    if (result.status === 'purged') {
      throw new GoneException('Media purged after retention expiry.');
    }
    if (result.status !== 'ok' || !result.data) {
      throw new NotFoundException('Media not found');
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', result.data.length);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(result.data);
  }

  // ---------------------------------------------------------------------------
  // POST /media/touch - refresh the retention clock for locally-cached media
  // ---------------------------------------------------------------------------
  /**
   * Marks media as used when the client served them from its own ciphertext cache.
   *
   * Without this the retention clock only ever advanced when a device that did NOT already
   * hold an object downloaded it, so an image everyone looks at daily expired on the same schedule
   * as one nobody ever opened again. See {@link MediaService.touch}.
   *
   * A JWT is required and no more: the body carries only opaque ids, the service holds only
   * ciphertext, and the sole effect is to POSTPONE a deletion. The worst a caller can do with
   * somebody else's id is keep an object alive slightly longer, which is why this does not need -
   * and deliberately does not have - the internal-secret gate that DELETE carries.
   */
  @Post('touch')
  async touch(
    @Body() body: { mediaIds?: unknown },
    @Req() req: Request
  ): Promise<{ refreshed: number }> {
    this.verifyToken(req);

    const ids = body?.mediaIds;
    if (!Array.isArray(ids)) {
      throw new BadRequestException('mediaIds must be an array');
    }
    // The batch is bounded here rather than trusted from the client: the client's own batching
    // caps it far lower, but a body is attacker-controlled and an unbounded loop over it is a
    // free way to hold the metadata lock.
    if (ids.length > TOUCH_MAX_IDS) {
      throw new BadRequestException(`mediaIds must hold at most ${TOUCH_MAX_IDS} entries`);
    }

    const refreshed = await this.mediaService.touch(
      ids.filter((id): id is string => typeof id === 'string')
    );
    return { refreshed };
  }

  // ---------------------------------------------------------------------------  // GET /media/:id
  // ---------------------------------------------------------------------------
  @Get(':id')
  async download(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    this.verifyToken(req);

    const result = await this.mediaService.download(id);
    if (result.status === 'purged') {
      throw new GoneException(
        'Media supprime apres expiration de retention. Merci de demander un renvoi.'
      );
    }
    if (result.status !== 'ok' || !result.data) {
      throw new NotFoundException('Media not found');
    }
    const data = result.data;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', data.length);
    // Prevent any caching of sensitive encrypted content
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.send(data);
  }

  // ---------------------------------------------------------------------------
  // DELETE /media/internal/users/:userId - account deletion fan-out (core-service)
  //
  // Declared BEFORE the catch-all `@Delete(':id')` for the same reason `internal/:id` precedes
  // `@Get(':id')`. No JWT: the caller is a service, not a user - the account is already gone by
  // the time the fan-out reaches here, so there is no token left to present.
  // ---------------------------------------------------------------------------
  @Delete('internal/users/:userId')
  async removeAllOwnedBy(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') internalSecret?: string
  ): Promise<{ ok: boolean; deleted: number; failed: number }> {
    assertInternalSecret(internalSecret);
    const { deleted, failed } = await this.mediaService.removeAllOwnedBy(userId);
    return { ok: true, deleted, failed };
  }

  // ---------------------------------------------------------------------------
  // DELETE /media/:id
  // ---------------------------------------------------------------------------
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
    @Headers('x-internal-secret') internalSecret?: string
  ): Promise<{ ok: boolean }> {
    this.verifyToken(req);
    // Deletion is server-to-server only (social-service cleanup). The shared secret is the
    // authorization gate - the JWT above merely proves an authenticated user triggered it.
    // Blocks a logged-in client from deleting enumerable public media (asso logos, etc.).
    assertInternalSecret(internalSecret);
    await this.mediaService.remove(id);
    return { ok: true };
  }
}
