/**
 * MediaController
 *
 * Endpoints:
 *   GET  /media/limits  - The one ceiling, so no client has to be built carrying a copy of it
 *   POST /media/upload  - Receive an encrypted blob, store it, return { mediaId }
 *   GET  /media/:id     - Return the encrypted blob (client decrypts it), or one byte range of it
 *                         (206 + Content-Range) - how a segmented video is read while it plays
 *   POST   /media/upload/session            - open a resumable streamed upload (WP-S1)
 *   PUT    /media/upload/session/:id/parts/:index - one raw part, streamed to disk, never over 8 MiB
 *   GET    /media/upload/session/:id        - the parts the server holds (the resume fact)
 *   POST   /media/upload/session/:id/complete - assemble; idempotent
 *   DELETE /media/upload/session/:id        - cancel, release the budget now
 *   POST /media/touch   - Refresh the retention clock for media the client had cached locally
 *   DELETE /media/:id   - Remove a blob (server-to-server only: valid JWT + X-Internal-Secret)
 *   POST /media/internal/retention-class - set an object's retention class (X-Internal-Secret)
 *   POST /media/internal/reel-claim - claim a CanaReel's blob for its author (X-Internal-Secret)
 *   POST /media/internal/reel-purge - delete expired reels' blobs, per owner (X-Internal-Secret)
 *   POST /media/internal/form-file - store a form answer's file, plaintext, class form-file
 *   POST /media/internal/form-file-purge - delete form files, per uploader (X-Internal-Secret)
 *   GET  /media/internal/form-file/:id - read a form file, and nothing else (X-Internal-Secret)
 *   POST /media/internal/live/:liveId/:name - store one sealed live segment (X-Internal-Secret)
 *   POST /media/internal/live-purge - delete every segment of an ended live (X-Internal-Secret)
 *   POST /media/internal/live-segments-delete - delete named segments behind a RUNNING live's window (X-Internal-Secret)
 *   GET  /media/public/live/:liveId/:name - one sealed live segment, by the name its manifest gave
 *                         (NO JWT: ciphertext, cached by Canari's nginx - WP-L4)
 *   (the three live routes answer 404 unless LIVE_ENABLED=true - docs/wiki/services/lives.md)
 *
 * A `form-file` object is served by `GET /media/internal/form-file/:id` ONLY: `GET /media/:id` and
 * `GET /media/internal/:id` (the push media proxy's) answer 404 for it - neither has a per-object
 * ACL, and the file is plaintext.
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
  Put,
  Delete,
  HttpCode,
  Param,
  Body,
  Res,
  Req,
  Headers,
  UseInterceptors,
  UploadedFile,
  NotFoundException,
  GoneException,
  ForbiddenException,
  InternalServerErrorException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  BadRequestException,
  UnprocessableEntityException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import {
  MediaService,
  boundedSharp,
  FORM_FILE_MAX_BYTES,
  isRetentionClass,
  POSTER_CLASSES,
  SERVER_READ_ONLY_CLASS,
  type FormFilePurgeOutcome,
  type MediaStorageStats,
  type ReelPurgeOutcome,
  type RetentionClass,
} from './media.service';
import { UploadSessionService } from './upload-session.service';
import {
  LIVE_SEGMENT_MAX_BYTES,
  LiveSegmentsService,
  isLiveEnabled,
  type LivePurgeResult,
  LIVE_TRIM_MAX_NAMES,
  type LiveTrimResult,
} from './live-segments.service';
import { assertInternalSecret } from './internal-secret.util';
import { fetchLivesMode } from './lives-mode';
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

/**
 * The class a CLIENT upload names, read from its body.
 *
 * An unrecognised value is ignored rather than refused (an old client sends none, and failing an
 * upload over it would break posting; an unclassified object is KEPT). `form-file` is REFUSED: it is
 * the plaintext class only social-service may create (`POST internal/form-file`), and a client naming
 * it would mint an object nobody tracks, kept for ever and readable by nobody. A CLAIMED poster's
 * class (`poster`, `poster-association`) is refused too: only `internal/poster-claim` sets it, on
 * a `poster-pending` upload, and a client minting `poster-association` would keep its object past
 * its own erasure, bound to no space.
 */
export function clientRetentionClass(value: unknown): RetentionClass | undefined {
  if (
    value === SERVER_READ_ONLY_CLASS ||
    (typeof value === 'string' && POSTER_CLASSES.has(value))
  ) {
    throw new BadRequestException(`class '${String(value)}' is not a client upload class`);
  }
  return isRetentionClass(value) ? value : undefined;
}

@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(
    private readonly mediaService: MediaService,
    private readonly uploadSessions: UploadSessionService,
    private readonly liveSegments: LiveSegmentsService
  ) {}

  /**
   * THE DEPLOY LOCK: 404 on every live route while `LIVE_ENABLED` is off - what a route that does
   * not exist answers. Asked first, before anything costs a hop.
   */
  private assertLiveEnabled(): void {
    if (!isLiveEnabled()) {
      this.logger.debug('[LIVE] a live route was called while LIVE_ENABLED is off - 404');
      throw new NotFoundException();
    }
  }

  /**
   * THE RUNTIME KILL SWITCH: 404 while `platform_config.lives_mode` is not `on`, asked of
   * social-service on every call ({@link fetchLivesMode}, which fails closed). Each route asks it
   * AFTER its own cheap refusals (the secret, the canonical path), so a caller that would be refused
   * anyway never makes this service reach social-service.
   */
  private async assertLivesModeOn(): Promise<void> {
    if ((await fetchLivesMode(this.logger)) !== 'on') {
      this.logger.debug('[LIVE] a live route was called while lives_mode is off - 404');
      throw new NotFoundException();
    }
  }

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
    // Unrecognised values are ignored rather than refused: an old client sends none at all, and
    // failing an upload over it would break posting outright. An object with no class is KEPT -
    // the sweep is an allowlist of `ephemeral` - so a missing hint costs storage, never a file.
    const retentionClass = clientRetentionClass(body?.retentionClass);

    const mediaId = await this.mediaService.upload(upload.buffer, ownerId, retentionClass);
    this.logger.log(
      `Stored encrypted blob: ${mediaId} (${upload.size} bytes, retention=${retentionClass ?? 'unclassified'})`
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

    // Resize to max 256x256, convert to WebP 90% - logos and avatars are public/unencrypted. The
    // decode is bounded (`boundedSharp`): a small file declaring huge dimensions is a 422, not an
    // allocation of gigabytes in the process that carries every chat medium.
    let compressed: Buffer;
    try {
      compressed = await boundedSharp(upload.buffer)
        .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 90 })
        .toBuffer();
    } catch (err) {
      this.logger.warn(
        `Public asset refused: the image does not decode within bounds (${upload.size} bytes): ${err instanceof Error ? err.message : String(err)}`
      );
      throw new UnprocessableEntityException('The image could not be read');
    }

    const mediaId = await this.mediaService.uploadPublicAsset(compressed, 'image/webp');
    this.logger.log(
      `Stored public asset: ${mediaId} (${upload.size} → ${compressed.length} bytes, webp)`
    );
    return { mediaId };
  }

  // ---------------------------------------------------------------------------  // POST /media/upload/chunk/init
  // ---------------------------------------------------------------------------
  @Post('upload/chunk/init')
  async initChunkedUpload(
    @Body() body: { retentionClass?: unknown; totalBytes?: unknown } | undefined,
    @Req() req: Request
  ): Promise<{ uploadId: string }> {
    const ownerId = this.verifyToken(req);
    // A `chat-reel` declares its class and total HERE so the daily budget is reserved before any
    // byte is staged; every other caller sends no body and is unchanged.
    const retentionClass = clientRetentionClass(body?.retentionClass);
    const totalBytes = typeof body?.totalBytes === 'number' ? body.totalBytes : undefined;
    const uploadId = await this.mediaService.initChunkedUpload(
      ownerId,
      retentionClass,
      totalBytes,
      MAX_BYTES
    );
    this.logger.log(
      `Initialized chunked upload: ${uploadId} (retention=${retentionClass ?? 'unclassified'})`
    );
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
    const ownerId = this.verifyToken(req);
    const buffer = uploadedFileBuffer(file);
    await this.mediaService.appendChunk(id, buffer, MAX_BYTES, ownerId);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // DELETE /media/upload/chunk/:id - a client abandons ITS OWN staged session (cancel, refusal, a
  // stalled attempt it is replacing). Idempotent, owner-checked, 204 either way. LEGACY: retired
  // with the chunk routes (media-streaming-upload WP-S6).
  // ---------------------------------------------------------------------------
  @Delete('upload/chunk/:id')
  @HttpCode(204)
  async abortChunkedUpload(@Param('id') id: string, @Req() req: Request): Promise<void> {
    const ownerId = this.verifyToken(req);
    await this.mediaService.abortChunkedUpload(id, ownerId);
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
    const retentionClass = clientRetentionClass(body?.retentionClass);
    const mediaId = await this.mediaService.completeChunkedUpload(
      id,
      MAX_BYTES,
      ownerId,
      retentionClass
    );
    this.logger.log(
      `Completed chunked upload: ${id} -> ${mediaId} (retention=${retentionClass ?? 'unclassified'})`
    );
    return { mediaId };
  }

  // ---------------------------------------------------------------------------
  // Upload sessions: streamed, resumable, every request body under 8 MiB.
  // docs/wiki/services/media-streaming-upload.md. NONE of these routes declares a FileInterceptor:
  // a part is the raw request stream, piped to disk, never a buffer of the body.
  // ---------------------------------------------------------------------------
  @Post('upload/session')
  async initUploadSession(
    @Body()
    body:
      | { retentionClass?: unknown; totalBytes?: unknown; partBytes?: unknown; header?: unknown }
      | undefined,
    @Req() req: Request
  ) {
    const ownerId = this.verifyToken(req);
    const retentionClass = clientRetentionClass(body?.retentionClass);
    return this.uploadSessions.init(
      ownerId,
      {
        retentionClass,
        totalBytes: body?.totalBytes,
        partBytes: body?.partBytes,
        header: body?.header,
      },
      MAX_BYTES
    );
  }

  @Put('upload/session/:id/parts/:index')
  async putUploadPart(
    @Param('id') id: string,
    @Param('index') index: string,
    @Req() req: Request
  ): Promise<{ index: number; receivedCount: number }> {
    const ownerId = this.verifyToken(req);
    // Digits only: `Number('')` and `Number('0x10')` would otherwise pass for indexes.
    if (!/^[0-9]{1,6}$/.test(index)) throw new BadRequestException('Invalid part index');
    const header = req.headers['content-length'];
    const contentLength =
      typeof header === 'string' && /^[0-9]+$/.test(header) ? Number(header) : undefined;
    return this.uploadSessions.putPart(ownerId, id, Number(index), req, contentLength);
  }

  @Get('upload/session/:id')
  async uploadSessionStatus(@Param('id') id: string, @Req() req: Request) {
    return this.uploadSessions.status(this.verifyToken(req), id);
  }

  @Post('upload/session/:id/complete')
  async completeUploadSession(
    @Param('id') id: string,
    @Req() req: Request
  ): Promise<{ mediaId: string }> {
    return this.uploadSessions.complete(this.verifyToken(req), id);
  }

  @Delete('upload/session/:id')
  async cancelUploadSession(
    @Param('id') id: string,
    @Req() req: Request
  ): Promise<{ ok: boolean }> {
    await this.uploadSessions.cancel(this.verifyToken(req), id);
    return { ok: true };
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
   * Sets the retention class (`'ephemeral'`, `'archive'`, `'association'`) of objects that
   * already exist.
   *
   * Sole consumer: social-service, which owns the post and vault-document rows and is therefore
   * the only party that can say an object is still cited by one. It classifies what was uploaded
   * before the class existed, and releases (`'ephemeral'`) what a deleted post no longer references.
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

    // A class is REQUIRED, and there is no null: the release is `ephemeral` itself. This used to
    // read an absent key as `null`, the release - so a body that forgot the field silently moved a
    // batch onto the idle clock, the opposite of what its comment promised.
    if (!isRetentionClass(body?.retentionClass)) {
      throw new BadRequestException(
        "retentionClass must be one of 'ephemeral', 'archive', 'association'"
      );
    }
    const retentionClass: RetentionClass = body.retentionClass;
    // `reel` is claimed THROUGH ITS OWNER (`internal/reel-claim`), never set on an id alone: the
    // class is what a reel's purge is attached to, and this route has no idea whose object it names.
    if (retentionClass === 'reel') {
      throw new BadRequestException(
        "class 'reel' is set by POST internal/reel-claim, with an owner"
      );
    }
    // `chat-reel` and `reel-pending` are attached AT UPLOAD, where the owner (and for a chat-reel
    // the size) are known: applying either to an existing id would make that object sweepable by
    // age - a claimed reel's blob deleted under its live post.
    // `form-file` likewise: only `internal/form-file` creates one, with its uploader.
    // The poster classes likewise: `poster-pending` at upload, the claimed ones by
    // `internal/poster-claim` with an owner and a space.
    if (
      retentionClass === 'chat-reel' ||
      retentionClass === 'reel-pending' ||
      retentionClass === SERVER_READ_ONLY_CLASS ||
      retentionClass === 'poster-pending' ||
      POSTER_CLASSES.has(retentionClass)
    ) {
      throw new BadRequestException(
        `class '${retentionClass}' is set by the upload that creates the object`
      );
    }

    const changed = await this.mediaService.setRetentionClass(
      ids.filter((id): id is string => typeof id === 'string'),
      retentionClass
    );
    if (changed > 0) {
      this.logger.log(`Retention class ${retentionClass} applied to ${changed} object(s)`);
    }
    return { changed };
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/promote-public - repair avatars stored behind the JWT route
  // ---------------------------------------------------------------------------
  /**
   * Makes existing group avatars and community images servable by `GET /media/public/:id`. They
   * were uploaded through `POST /media/upload`, so the invite card, the link preview and the SEO
   * head - all unauthenticated - got a 404 for them. The caller names the ids (it owns the rows
   * that cite them); the service promotes only blobs that decode as JPEG, PNG or WebP.
   */
  @Post('internal/promote-public')
  async promotePublic(
    @Body() body: { mediaIds?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ promoted: number; refused: string[] }> {
    assertInternalSecret(internalSecret);

    const ids = body?.mediaIds;
    if (!Array.isArray(ids)) {
      throw new BadRequestException('mediaIds must be an array');
    }
    if (ids.length > RETENTION_CLASS_MAX_IDS) {
      throw new BadRequestException(
        `mediaIds must hold at most ${RETENTION_CLASS_MAX_IDS} entries`
      );
    }

    const { promoted, refused } = await this.mediaService.promoteToPublicAssets(
      ids.filter((id): id is string => typeof id === 'string')
    );
    this.logger.log(
      `Promoted ${promoted.length} object(s) to public assets, ${refused.length} refused`
    );
    return { promoted: promoted.length, refused };
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/reel-claim - a reel's blob is claimed for its author
  // ---------------------------------------------------------------------------
  /**
   * Classifies blobs `reel` on behalf of the member who is publishing a CanaReel.
   *
   * Sole consumer: social-service's `createPost` for `kind: 'reel'`. It exists to PROVE, from the
   * entry's recorded uploader, that the blob a reel cites is the author's - the property the later
   * purge's safety rests on. See {@link MediaService.claimReels}. Same fail-closed secret gate as
   * every internal route; no user JWT, because the caller is a service acting after authenticating
   * the member itself.
   */
  @Post('internal/reel-claim')
  async claimReels(
    @Body() body: { mediaIds?: unknown; ownerId?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ claimed: string[]; refused: string[] }> {
    assertInternalSecret(internalSecret);
    const ids = this.boundedIds(body?.mediaIds, 'mediaIds');
    if (typeof body?.ownerId !== 'string' || body.ownerId.length === 0) {
      throw new BadRequestException('ownerId must be a non-empty string');
    }
    return this.mediaService.claimReels(ids, body.ownerId);
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/poster-claim - a booking space's poster, claimed for its uploader
  // ---------------------------------------------------------------------------
  /**
   * Sole consumer: social-service's `BookingPosterMedia.claim`, before a space stores a poster. It
   * PROVES the object is the member's own fresh upload; the rule is {@link MediaService.claimPosters}.
   */
  @Post('internal/poster-claim')
  async claimPosters(
    @Body()
    body: { mediaIds?: unknown; ownerId?: unknown; spaceId?: unknown; retentionClass?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ claimed: string[]; refused: string[] }> {
    assertInternalSecret(internalSecret);
    const ids = this.boundedIds(body?.mediaIds, 'mediaIds');
    if (typeof body?.ownerId !== 'string' || body.ownerId.length === 0) {
      throw new BadRequestException('ownerId must be a non-empty string');
    }
    if (typeof body.spaceId !== 'string' || body.spaceId.length === 0) {
      throw new BadRequestException('spaceId must be a non-empty string');
    }
    if (body.retentionClass !== 'poster' && body.retentionClass !== 'poster-association') {
      throw new BadRequestException("retentionClass must be 'poster' or 'poster-association'");
    }
    return this.mediaService.claimPosters(ids, body.ownerId, body.spaceId, body.retentionClass);
  }

  /**
   * Releases claimed posters to the idle sweep. Sole consumer: social-service's
   * `releaseUncitedPosters`; the class allowlist is {@link MediaService.releasePosters}.
   */
  @Post('internal/poster-release')
  async releasePosters(
    @Body() body: { mediaIds?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ released: string[]; refused: string[] }> {
    assertInternalSecret(internalSecret);
    return this.mediaService.releasePosters(this.boundedIds(body?.mediaIds, 'mediaIds'));
  }

  /**
   * Every claimed poster and its space. Sole consumer: social-service's poster reconciliation
   * (`BookingPosterMedia.reconcileOnce`).
   */
  @Get('internal/poster-list')
  listPosters(@Headers('x-internal-secret') internalSecret: string | undefined): {
    posters: Array<{ mediaId: string; spaceId: string | null }>;
  } {
    assertInternalSecret(internalSecret);
    return { posters: this.mediaService.listPosters() };
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/reel-purge - delete the blobs of expired or deleted reels
  // ---------------------------------------------------------------------------
  /**
   * Deletes blobs on their owner's say-so and answers one outcome per id. Sole consumer:
   * social-service's `ReelRetentionScheduler` and the delete of a reel. The allowlist (ownership,
   * never a class) and the meaning of each outcome are on {@link MediaService.purgeReels}.
   */
  @Post('internal/reel-purge')
  async purgeReels(
    @Body() body: { items?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ results: Record<string, ReelPurgeOutcome> }> {
    assertInternalSecret(internalSecret);
    const raw = body?.items;
    if (!Array.isArray(raw)) {
      throw new BadRequestException('items must be an array');
    }
    if (raw.length > RETENTION_CLASS_MAX_IDS) {
      throw new BadRequestException(`items must hold at most ${RETENTION_CLASS_MAX_IDS} entries`);
    }
    const items = raw.map((item) => {
      const { mediaId, ownerId } = (item ?? {}) as { mediaId?: unknown; ownerId?: unknown };
      if (typeof mediaId !== 'string' || typeof ownerId !== 'string') {
        throw new BadRequestException('each item needs a string mediaId and ownerId');
      }
      return { mediaId, ownerId };
    });
    const results = await this.mediaService.purgeReels(items);
    const counts = { deleted: 0, absent: 0, refused: 0, failed: 0 };
    for (const outcome of Object.values(results)) counts[outcome] += 1;
    if (counts.deleted + counts.refused + counts.failed > 0) {
      this.logger.log(
        `Reel purge: ${counts.deleted} deleted, ${counts.absent} absent, ${counts.refused} refused, ${counts.failed} failed`
      );
    }
    return { results };
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/form-file - store the file of a form's FILE question
  // ---------------------------------------------------------------------------
  /**
   * Stores a form answer's file (a CV) as class `form-file`, PLAINTEXT, for the member named by
   * `ownerId`. Sole consumer: social-service's `POST /forms/:id/files`, which authenticated the
   * member, checked the form and the question, the size and the type (read from the bytes) before
   * calling. No user JWT: the caller is a service. The object is readable only through
   * `GET internal/form-file/:id` - see `form-file` on {@link RetentionClass}.
   */
  @Post('internal/form-file')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: FORM_FILE_MAX_BYTES + 1 }, storage: undefined })
  )
  async uploadFormFile(
    @UploadedFile() file: unknown,
    @Body() body: { ownerId?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ mediaId: string; sizeBytes: number }> {
    assertInternalSecret(internalSecret);
    if (typeof body?.ownerId !== 'string' || body.ownerId.length === 0) {
      throw new BadRequestException('ownerId must be a non-empty string');
    }
    const upload = requireUploadedFile(file);
    // An image is re-encoded without its metadata (EXIF, GPS) before it is stored; `sizeBytes` is
    // what was STORED, never over FORM_FILE_MAX_BYTES. An image that does not decode, exceeds the
    // pixel bound or cannot fit the cap is a 422.
    return this.mediaService.uploadFormFile(upload.buffer, body.ownerId);
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/form-file-purge - delete form files whose retention ran out
  // ---------------------------------------------------------------------------
  /**
   * Deletes form files on their uploader's name and answers one outcome per id. Sole consumer:
   * social-service's `FormFileRetentionScheduler`. The allowlist (class `form-file` AND the named
   * uploader) and the outcomes are on {@link MediaService.purgeFormFiles}.
   */
  @Post('internal/form-file-purge')
  async purgeFormFiles(
    @Body() body: { items?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ results: Record<string, FormFilePurgeOutcome> }> {
    assertInternalSecret(internalSecret);
    const raw = body?.items;
    if (!Array.isArray(raw)) {
      throw new BadRequestException('items must be an array');
    }
    if (raw.length > RETENTION_CLASS_MAX_IDS) {
      throw new BadRequestException(`items must hold at most ${RETENTION_CLASS_MAX_IDS} entries`);
    }
    const items = raw.map((item) => {
      const { mediaId, ownerId } = (item ?? {}) as { mediaId?: unknown; ownerId?: unknown };
      if (typeof mediaId !== 'string' || typeof ownerId !== 'string') {
        throw new BadRequestException('each item needs a string mediaId and ownerId');
      }
      return { mediaId, ownerId };
    });
    return { results: await this.mediaService.purgeFormFiles(items) };
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/live/:liveId/:name - one sealed live segment, from social-service
  // ---------------------------------------------------------------------------
  /**
   * Stores one sealed segment of a live under `live/<liveId>/<name>`. Sole consumer: social-service's
   * segment ingest (`PUT /api/lives/:id/segments/:index`), which authenticated the broadcaster,
   * holds the live's row, chose the random `name` and bounded the body before calling. The bound is
   * applied here again, as the store's own refusal. See {@link LiveSegmentsService}.
   */
  @Post('internal/live/:liveId/:name')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: LIVE_SEGMENT_MAX_BYTES + 1 },
      storage: undefined,
    })
  )
  async storeLiveSegment(
    @Param('liveId') liveId: string,
    @Param('name') name: string,
    @UploadedFile() file: unknown,
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ ok: true }> {
    this.assertLiveEnabled();
    assertInternalSecret(internalSecret);
    await this.assertLivesModeOn();
    const data = requireUploadedFile(file).buffer;
    if (data.length === 0 || data.length > LIVE_SEGMENT_MAX_BYTES) {
      throw new PayloadTooLargeException(`a live segment is 1 to ${LIVE_SEGMENT_MAX_BYTES} bytes`);
    }
    await this.liveSegments.store(liveId, name, data);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/live-purge - every segment of an ended live
  // ---------------------------------------------------------------------------
  /**
   * Deletes every object under one live's prefix and answers the deletes, the refusals and a
   * RE-LISTING (`remaining`). Sole consumer: social-service, at a live's end and in its live sweep,
   * which deletes its row only when the answer proves the prefix empty. Runs whatever the switch
   * says: a live started while it was on is still deleted after it is turned off.
   */
  @Post('internal/live-purge')
  async purgeLive(
    @Body() body: { liveId?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<LivePurgeResult> {
    assertInternalSecret(internalSecret);
    if (typeof body?.liveId !== 'string') throw new BadRequestException('liveId must be a string');
    return this.liveSegments.purge(body.liveId);
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/live-segments-delete - the segments behind a running live's window
  // ---------------------------------------------------------------------------
  /**
   * Deletes the named segments of one live that is still on air (at most {@link LIVE_TRIM_MAX_NAMES}
   * per call). Sole consumer: social-service's trim, which names only segments behind the manifest
   * window plus its margin. Runs whatever the switch says, as the purge does: a live started while
   * it was on is still trimmed.
   */
  @Post('internal/live-segments-delete')
  async deleteLiveSegments(
    @Body() body: { liveId?: unknown; names?: unknown },
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<LiveTrimResult> {
    assertInternalSecret(internalSecret);
    if (typeof body?.liveId !== 'string') throw new BadRequestException('liveId must be a string');
    const names = body.names;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.length > LIVE_TRIM_MAX_NAMES ||
      names.some((n) => typeof n !== 'string')
    ) {
      throw new BadRequestException(`names must be 1 to ${LIVE_TRIM_MAX_NAMES} strings`);
    }
    return this.liveSegments.deleteSegments(body.liveId, names as string[]);
  }

  // ---------------------------------------------------------------------------
  // POST /media/internal/live-list - the live ids that have segments in the store
  // ---------------------------------------------------------------------------
  /**
   * One id per `live/<liveId>/` folder. Sole consumer: social-service's orphan reaper, which purges
   * a folder only when no live row is behind it (a store that outlived its timeout and landed after
   * its live's purge). Runs whatever the switch says, as the purge does.
   */
  @Post('internal/live-list')
  @HttpCode(200)
  async listLives(
    @Headers('x-internal-secret') internalSecret: string | undefined
  ): Promise<{ liveIds: string[] }> {
    assertInternalSecret(internalSecret);
    return { liveIds: await this.liveSegments.listLives() };
  }

  /** A string array bounded like every internal batch, ids that are not strings dropped. */
  private boundedIds(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException(`${field} must be an array`);
    }
    if (value.length > RETENTION_CLASS_MAX_IDS) {
      throw new BadRequestException(
        `${field} must hold at most ${RETENTION_CLASS_MAX_IDS} entries`
      );
    }
    return value.filter((id): id is string => typeof id === 'string');
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
    // A form file is NOT served here: this route answers the push proxy, which any member's device
    // reaches with an id. Form files have their own route below.
    await this.sendInternal(id, false, res);
  }

  // ---------------------------------------------------------------------------
  // GET /media/internal/form-file/:id - a form answer's file, to social-service only
  // ---------------------------------------------------------------------------
  /**
   * The ONE read of a `form-file` object, for social-service's manager-gated download
   * (`GET /api/forms/:id/files/:fileId`, after `assertFormManager`). It serves form files and nothing
   * else, so this route can never become a second way into ordinary media either.
   */
  @Get('internal/form-file/:id')
  async downloadFormFile(
    @Param('id') id: string,
    @Headers('x-internal-secret') internalSecret: string | undefined,
    @Res() res: Response
  ): Promise<void> {
    assertInternalSecret(internalSecret);
    await this.sendInternal(id, true, res);
  }

  /** The bytes of one object to an internal caller: 410 when purged, 404 when absent or refused. */
  private async sendInternal(id: string, formFile: boolean, res: Response): Promise<void> {
    const result = await this.mediaService.download(id, formFile);
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

  // ---------------------------------------------------------------------------
  // GET /media/public/live/:liveId/:name - one sealed live segment, no JWT (WP-L4)
  // ---------------------------------------------------------------------------
  /**
   * One sealed segment of a live, by the random name its manifest listed. NO ACCOUNT IS CHECKED,
   * and that is the plan's C9 model (docs/wiki/services/lives.md, "Serving a segment"): the bytes
   * are ciphertext under the live's key, which only social-service hands out (a removed or blocked
   * viewer is refused it, and the manifest that names the next segment); the names are random
   * uuids chosen by the server at ingest. What an unauthenticated route buys is that the SAME bytes
   * answer every viewer, so Canari's nginx caches them (`proxy_cache`, `live_segments` zone) and a
   * second viewer's fetch never reaches this process: this handler runs about once per segment, not
   * once per viewer.
   *
   * Cache-Control is NOT set here: the nginx location in front owns the header every client sees
   * (and ignores any upstream one for its own cache), so the policy is stated once.
   * Four path segments, so it collides neither with `public/:id` nor with the catch-all `:id`.
   *
   * ONLY THE CANONICAL PATH IS ANSWERED, everything else is a 404 before the store is asked
   * ({@link LiveSegmentsService.isCanonicalSegmentPath}): Express 5 would match an upper-case id, a
   * trailing slash or `/api/media/PUBLIC/...`, and every such spelling is an address nginx neither
   * caches nor rate-limits - a way to reach the store once per request (the review of #2105).
   */
  @Get('public/live/:liveId/:name')
  async downloadLiveSegment(
    @Param('liveId') liveId: string,
    @Param('name') name: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    this.assertLiveEnabled();
    if (!LiveSegmentsService.isCanonicalSegmentPath(req.originalUrl, liveId, name)) {
      // DEBUG, not warn: an unauthenticated caller reaches this through `/api/media/public/` (any
      // case variant), which no rate applies to - a warn there is noise anybody can force.
      this.logger.debug(
        `[LIVE] segment refused: not the canonical path (${req.originalUrl.slice(0, 200)})`
      );
      throw new NotFoundException('Live segment not found');
    }
    await this.assertLivesModeOn();
    const { stream, size } = await this.liveSegments.read(liveId, name);
    this.logger.debug(`[LIVE] segment ${liveId}/${name} served to the edge cache (${size} B)`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', size);
    stream.on('error', (err) => {
      this.logger.warn(`[LIVE] segment ${liveId}/${name} stream failed: ${String(err)}`);
      res.destroy(err);
    });
    stream.pipe(res);
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

    const result = await this.mediaService.downloadRange(id, req.headers.range);
    if (result.status === 'purged') {
      throw new GoneException(
        'Media supprime apres expiration de retention. Merci de demander un renvoi.'
      );
    }
    // Prevent any caching of sensitive encrypted content
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    // Said on every answer, so a client can learn that parts are served without asking for one.
    res.setHeader('Accept-Ranges', 'bytes');
    if (result.status === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${result.size}`);
      res.status(416).send();
      return;
    }
    if (result.status !== 'ok' || !result.data) {
      throw new NotFoundException('Media not found');
    }
    const data = result.data;

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', data.length);
    if (result.range) {
      res.setHeader(
        'Content-Range',
        `bytes ${result.range.start}-${result.range.end}/${result.size}`
      );
      res.status(206);
    }
    res.send(data);
  }

  // ---------------------------------------------------------------------------
  // DELETE /media/internal/users/:userId - account deletion fan-out (core-service)
  //
  // Declared BEFORE the catch-all `@Delete(':id')` for the same reason `internal/:id` precedes
  // `@Get(':id')`. No JWT: the caller is a service, not a user - the account is already gone by
  // the time the fan-out reaches here, so there is no token left to present. Called by core-service's
  // durable erasure queue, which retries until this answers 2xx: hence 503 while anything failed.
  // ---------------------------------------------------------------------------
  @Delete('internal/users/:userId')
  async removeAllOwnedBy(
    @Param('userId') userId: string,
    @Headers('x-internal-secret') internalSecret?: string
  ): Promise<{ ok: boolean; deleted: number; failed: number }> {
    assertInternalSecret(internalSecret);
    // The open upload sessions first: no device of an erased account can release them any more.
    await this.uploadSessions.cancelAllOwnedBy(userId);
    const { deleted, failed } = await this.mediaService.removeAllOwnedBy(userId);
    if (failed > 0) {
      // A 2xx would tell the erasure queue this half is done. It is not: the objects that failed
      // are still stored, and only a retry of this call removes them.
      throw new ServiceUnavailableException({ code: 'ERASURE_INCOMPLETE', deleted, failed });
    }
    return { ok: true, deleted, failed };
  }

  // ---------------------------------------------------------------------------
  // DELETE /media/chat-reel/:id - the SENDER takes back a reel sent in a conversation
  //
  // A user route (JWT, no internal secret), unlike `DELETE /media/:id`: it is safe to expose because
  // the service allows exactly one thing - the caller's OWN object of class `chat-reel`
  // (`removeChatReel`). A reel message cannot be forwarded, so no other conversation can cite the
  // blob. Two segments, so it never collides with the catch-all `@Delete(':id')` below.
  // ---------------------------------------------------------------------------
  @Delete('chat-reel/:id')
  async removeChatReel(@Param('id') id: string, @Req() req: Request): Promise<{ ok: boolean }> {
    const ownerId = this.verifyToken(req);
    const outcome = await this.mediaService.removeChatReel(id, ownerId);
    if (outcome === 'refused') {
      throw new ForbiddenException('Not a reel you sent');
    }
    if (outcome === 'failed') {
      throw new InternalServerErrorException('The reel could not be deleted. Try again.');
    }
    this.logger.log(`Chat-reel ${id}: ${outcome} for its sender`);
    return { ok: true };
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
