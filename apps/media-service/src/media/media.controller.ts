/**
 * MediaController
 *
 * Endpoints:
 *   POST /media/upload  - Receive an encrypted blob, store it, return { mediaId }
 *   GET  /media/:id     - Return the encrypted blob (client decrypts it)
 *   DELETE /media/:id   - Remove a blob (server-to-server only: valid JWT + X-Internal-Secret)
 *
 * Authentication: Bearer JWT validated via the shared JWT_SECRET env var.
 * The token carries `sub` (userId). Deletion additionally requires the shared
 * X-Internal-Secret so only social-service (which owns association-admin authz) can
 * remove blobs - a logged-in client cannot delete another association's public assets.
 *
 * Size limit: configurable via MEDIA_MAX_SIZE_MB (default 20 MB).
 * The service never inspects the ciphertext content.
 */
import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
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
import { MediaService } from './media.service';
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

    if (expected !== sigB64) {
      throw new UnauthorizedException('Invalid JWT signature');
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      throw new UnauthorizedException('JWT expired');
    }

    return payload.sub as string;
  }

  // ---------------------------------------------------------------------------
  // POST /media/upload
  // ---------------------------------------------------------------------------
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: MAX_BYTES },
      // Store entirely in memory - we pass raw bytes to MinIO
      storage: undefined,
    })
  )
  async upload(@UploadedFile() file: unknown, @Req() req: Request): Promise<{ mediaId: string }> {
    this.verifyToken(req);

    let upload: ReturnType<typeof requireUploadedFile>;
    try {
      upload = requireUploadedFile(file);
    } catch {
      throw new PayloadTooLargeException(
        `No file provided or file exceeds size limit (${POLICY_MAX_MEDIA_MB} MB max)`
      );
    }

    const mediaId = await this.mediaService.upload(upload.buffer);
    this.logger.log(`Stored encrypted blob: ${mediaId} (${upload.size} bytes)`);
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
    @Req() req: Request
  ): Promise<{ mediaId: string }> {
    this.verifyToken(req);
    const mediaId = await this.mediaService.completeChunkedUpload(id, MAX_BYTES);
    this.logger.log(`Completed chunked upload: ${id} -> ${mediaId}`);
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
