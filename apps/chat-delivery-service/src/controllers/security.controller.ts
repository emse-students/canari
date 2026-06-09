import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  BadRequestException,
  ForbiddenException,
  UseGuards,
  Headers,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import {
  sanitizeQueryValue,
  sanitizeOptionalQueryValue,
} from '../utils/sanitize';
import {
  assertSafeExternalUrl,
  fetchYouTubeOEmbed,
  fetchMiGalleryPreview,
  buildLinkPreviewPayload,
} from '../utils/url-guard';

/** PIN verifier and link-preview (SSRF-protected) endpoints. */
@Controller()
export class SecurityController {
  private readonly logger = new Logger(SecurityController.name);

  constructor(
    @InjectRepository(PinVerifier)
    private pinVerifierRepo: Repository<PinVerifier>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
  ) {}

  /**
   * Check (and register on first use) the PIN verifier for a user.
   *
   * The client sends a PBKDF2-SHA-256 verifier derived from the PIN and
   * userId.  We never see the raw PIN.
   *
   * Responses:
   *   { status: 'registered' }  – first device; verifier stored server-side.
   *   { status: 'ok' }          – verifier matches; PIN is consistent.
   *   { status: 'mismatch' }    – verifier differs; wrong PIN for this user.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/security/pin-check')
  async checkPinVerifier(
    @Body() body: { userId: string; verifier: string; deviceId?: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    if (headerGlobalAdmin !== 'true') {
      const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
      if (
        !caller ||
        caller.trim().toLowerCase() !== safeUserId.trim().toLowerCase()
      ) {
        throw new ForbiddenException(
          'PIN verifier check is restricted to the authenticated user',
        );
      }
    }
    const safeVerifier = sanitizeQueryValue(body.verifier, 'verifier');
    const safeDeviceId = sanitizeOptionalQueryValue(body.deviceId, 'deviceId');

    // Verifier must be a 64-char lowercase hex string (32 bytes PBKDF2 output).
    if (!/^[0-9a-f]{64}$/.test(safeVerifier)) {
      throw new BadRequestException('verifier format invalid');
    }

    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
    });

    if (!doc) {
      const newDoc = this.pinVerifierRepo.create({
        userId: safeUserId,
        verifier: safeVerifier,
      });
      await this.pinVerifierRepo.save(newDoc);
      return { status: 'registered', resetRequired: false };
    }

    if (typeof doc.verifier !== 'string') {
      throw new BadRequestException('stored verifier format invalid');
    }

    // Constant-time comparison to prevent timing-based inference.
    const stored = Buffer.from(doc.verifier, 'hex');
    const incoming = Buffer.from(safeVerifier, 'hex');
    const match =
      stored.length === incoming.length &&
      crypto.timingSafeEqual(stored, incoming);

    let resetRequired = false;
    if (match && safeDeviceId) {
      const revoked = await this.revokedDeviceRepo.findOne({
        where: { userId: safeUserId, deviceId: safeDeviceId },
      });
      if (revoked) {
        // One-shot reset: signal the client once, then clear marker so the
        // same physical device can register again as a fresh device.
        await this.revokedDeviceRepo.delete(revoked.id);
        resetRequired = true;
        this.logger.log(
          `[PIN_VERIFIER] one-shot reset required for ${safeUserId}:${safeDeviceId}`,
        );
      }
    }

    return { status: match ? 'ok' : 'mismatch', resetRequired };
  }

  @Get('mls/link-preview')
  /** Fetches a safe external URL preview (SSRF-protected: private IPs and localhost are rejected). */
  async getLinkPreview(@Query('url') url: string) {
    if (!url || typeof url !== 'string') {
      throw new BadRequestException('url is required');
    }

    const targetUrl = await assertSafeExternalUrl(url);
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 4000);

    try {
      const oembedPayload = await fetchYouTubeOEmbed(targetUrl);
      if (oembedPayload) {
        return oembedPayload;
      }

      const galleryPayload = await fetchMiGalleryPreview(targetUrl);
      if (galleryPayload) {
        return galleryPayload;
      }

      let currentUrl = targetUrl;
      let response: Response | null = null;
      let redirectsCount = 0;
      const MAX_REDIRECTS = 3;

      while (redirectsCount <= MAX_REDIRECTS) {
        response = await fetch(currentUrl.toString(), {
          method: 'GET',
          redirect: 'manual', // 🔒 Empêcher les redirections automatiques
          signal: abortController.signal,
          headers: {
            'user-agent': 'CanariLinkPreview/1.0',
            accept: 'text/html,application/xhtml+xml',
          },
        });

        // Gérer manuellement les redirections
        if (response.status >= 300 && response.status <= 399) {
          const location = response.headers.get('location');
          if (!location) break;
          // 🔒 Valider la nouvelle URL cible contre les attaques SSRF (ex: redirection vers localhost)
          currentUrl = await assertSafeExternalUrl(
            new URL(location, currentUrl.href).toString(),
          );
          redirectsCount++;
        } else {
          break;
        }
      }

      if (!response || !response.ok) {
        throw new BadRequestException('Unable to fetch URL');
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.toLowerCase().includes('text/html')) {
        throw new BadRequestException('URL is not an HTML page');
      }

      const contentLength = Number.parseInt(
        response.headers.get('content-length') || '0',
        10,
      );
      if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
        throw new BadRequestException('Page is too large to preview');
      }

      const html = (await response.text()).slice(0, 220_000);
      return buildLinkPreviewPayload(html, targetUrl);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('Link preview failed');
    } finally {
      clearTimeout(timeout);
    }
  }
}
