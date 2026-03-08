/**
 * MediaController
 *
 * Endpoints:
 *   POST /media/upload  – Receive an encrypted blob, store it, return { mediaId }
 *   GET  /media/:id     – Return the encrypted blob (client decrypts it)
 *   DELETE /media/:id   – Remove a blob (owner only; simplified auth check)
 *
 * Authentication: Bearer JWT validated via the shared JWT_SECRET env var.
 * The token carries `sub` (userId); future work can enforce per-user ACL.
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
  UseInterceptors,
  UploadedFile,
  NotFoundException,
  PayloadTooLargeException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { MediaService } from './media.service';

const MAX_BYTES =
  parseInt(process.env.MEDIA_MAX_SIZE_MB ?? '20', 10) * 1024 * 1024;

@Controller('media')
export class MediaController {
  private readonly logger = new Logger(MediaController.name);

  constructor(private readonly mediaService: MediaService) {}

  // ---------------------------------------------------------------------------
  // Auth helper – validates the shared HS256 JWT (same secret as chat-gateway)
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

    const payload = JSON.parse(
      Buffer.from(payloadB64, 'base64').toString('utf8'),
    );
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
      // Store entirely in memory – we pass raw bytes to MinIO
      storage: undefined,
    }),
  )
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Req() req: Request,
  ): Promise<{ mediaId: string }> {
    this.verifyToken(req);

    if (!file) {
      throw new PayloadTooLargeException(
        'No file provided or file exceeds size limit',
      );
    }

    const mediaId = await this.mediaService.upload(file.buffer);
    this.logger.log(`Stored encrypted blob: ${mediaId} (${file.size} bytes)`);
    return { mediaId };
  }

  // ---------------------------------------------------------------------------
  // GET /media/:id
  // ---------------------------------------------------------------------------
  @Get(':id')
  async download(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    this.verifyToken(req);

    const data = await this.mediaService.download(id);
    if (!data) throw new NotFoundException('Media not found');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', data.length);
    // Prevent any caching of sensitive encrypted content
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate, private',
    );
    res.send(data);
  }

  // ---------------------------------------------------------------------------
  // DELETE /media/:id
  // ---------------------------------------------------------------------------
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<{ ok: boolean }> {
    this.verifyToken(req);
    await this.mediaService.remove(id);
    return { ok: true };
  }
}
