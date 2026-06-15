import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Res,
  BadRequestException,
  ForbiddenException,
  UseGuards,
  Headers,
  Logger,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { MessagingService } from '../services/messaging.service';
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
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    private readonly messagingService: MessagingService,
  ) {}

  /**
   * Authorises a PIN/security operation: the caller must be the target user
   * themselves (matched on the Nginx-injected `x-user-id` header) or a global
   * admin. Throws {@link ForbiddenException} otherwise.
   */
  private assertSelfOrGlobalAdmin(
    targetUserId: string,
    headerUserId?: string,
    headerGlobalAdmin?: string,
  ): void {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (
      !caller ||
      caller.trim().toLowerCase() !== targetUserId.trim().toLowerCase()
    ) {
      throw new ForbiddenException(
        'Operation restricted to the authenticated user',
      );
    }
  }

  /**
   * Check (and register on first use) the PIN verifier for a user.
   *
   * The client sends a PBKDF2-SHA-256 verifier derived from the PIN and
   * userId.  We never see the raw PIN.
   *
   * Responses:
   *   { status: 'registered' }  - first device; verifier stored server-side.
   *   { status: 'ok' }          - verifier matches; PIN is consistent.
   *   { status: 'mismatch' }    - verifier differs; wrong PIN for this user.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/security/pin-check')
  async checkPinVerifier(
    @Body() body: { userId: string; verifier: string; deviceId?: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);
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

  /**
   * Reports whether the user has ever registered a PIN (i.e. a PinVerifier row
   * exists). This is the source of truth for "first setup": the client shows the
   * "choose your PIN" flow only when `registered` is false. Unlike a device-count
   * heuristic, it stays correct for a user whose devices have all been revoked or
   * garbage-collected but who still has a registered PIN.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/security/pin-status/:userId')
  async getPinStatus(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<{ registered: boolean }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);
    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
      select: ['id'],
    });
    return { registered: !!doc };
  }

  /**
   * Updates a user's PIN verifier after an authenticated PIN change.
   *
   * The caller proves knowledge of the current PIN by sending its verifier
   * (`oldVerifier`); only if it matches the stored row is it overwritten with
   * `newVerifier`. The raw PIN is never transmitted. The actual re-encryption of
   * the MLS state happens client-side (`changePIN`); this only rotates the
   * account-wide verifier so the new PIN becomes the one accepted at login.
   *
   * Because the verifier is account-wide, other devices still holding the old PIN
   * will get a mismatch at their next login and must re-enter the new PIN.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/security/pin-change')
  async changePin(
    @Body() body: { userId: string; oldVerifier: string; newVerifier: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<{ ok: boolean }> {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);

    const oldVerifier = sanitizeQueryValue(body.oldVerifier, 'oldVerifier');
    const newVerifier = sanitizeQueryValue(body.newVerifier, 'newVerifier');
    if (
      !/^[0-9a-f]{64}$/.test(oldVerifier) ||
      !/^[0-9a-f]{64}$/.test(newVerifier)
    ) {
      throw new BadRequestException('verifier format invalid');
    }

    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
    });
    if (!doc || typeof doc.verifier !== 'string') {
      throw new BadRequestException('no PIN registered for this user');
    }

    const stored = Buffer.from(doc.verifier, 'hex');
    const incoming = Buffer.from(oldVerifier, 'hex');
    const matches =
      stored.length === incoming.length &&
      crypto.timingSafeEqual(stored, incoming);
    if (!matches) {
      throw new ForbiddenException('current PIN is incorrect');
    }

    doc.verifier = newVerifier;
    await this.pinVerifierRepo.save(doc);
    this.logger.log(`[PIN_CHANGE] verifier rotated for ${safeUserId}`);

    return { ok: true };
  }

  /**
   * Resets a user's PIN-protected MLS state without deleting their account.
   *
   * Used for the "forgot PIN" flow: the PIN is unrecoverable (never stored), so
   * the only way back in - short of deleting the whole account - is to wipe the
   * MLS material encrypted under the old PIN and start fresh under a new one.
   *
   * Scope (intentional):
   *   - Purges every device's MLS footprint (KeyPackages, one-time prekeys, push
   *     tokens, queued messages, Redis membership, per-device group memberships).
   *   - Deletes the PinVerifier so the next login registers a brand-new PIN.
   *   - Clears revocation markers so the same physical device can re-register.
   *   - KEEPS GroupMember rows: the user stays a member of their groups/DMs and is
   *     re-invited automatically (re-add flow) once a fresh device registers.
   *
   * Not affected: the account itself, social data, and community channels (which
   * use server-assisted HKDF keys, not the PIN). Past encrypted message history is
   * permanently lost - that is inherent to forgetting the PIN.
   */
  @UseGuards(HeaderAuthGuard)
  @Post('mls/security/pin-reset')
  async resetPin(
    @Body() body: { userId: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string,
  ): Promise<{ ok: boolean; devicesPurged: number }> {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);

    const devices = await this.keyPackageRepo.find({
      where: { userId: safeUserId },
      select: ['deviceId'],
    });
    const deviceIds = [...new Set(devices.map((d) => d.deviceId))];

    let devicesPurged = 0;
    for (const deviceId of deviceIds) {
      await this.messagingService.purgeDeviceFootprint(safeUserId, deviceId);
      devicesPurged++;
    }

    await Promise.all([
      this.pinVerifierRepo.delete({ userId: safeUserId }),
      this.revokedDeviceRepo.delete({ userId: safeUserId }),
    ]);

    this.logger.log(
      `[PIN_RESET] user=${safeUserId} devicesPurged=${devicesPurged} (GroupMember rows kept for re-add)`,
    );

    return { ok: true, devicesPurged };
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

  /**
   * Proxies a MiGallery album cover image using the server-side API key so the
   * browser never needs to handle MiGallery credentials directly.
   * This endpoint is intentionally unauthenticated - it only exposes album
   * thumbnails, which are already visible to all EMSE students on MiGallery.
   */
  @Get('mls/gallery-cover/:albumId')
  async getGalleryCover(
    @Param('albumId') albumId: string,
    @Res() res: ExpressResponse,
  ): Promise<void> {
    if (!albumId || !/^[0-9a-f-]{36}$/i.test(albumId)) {
      res.status(400).end('Invalid album ID');
      return;
    }

    const galleryBaseUrl = (
      process.env.MIGALLERY_API_URL || 'https://gallery.mitv.fr'
    ).replace(/\/$/, '');
    const apiKey = process.env.MIGALLERY_API_KEY || '';

    if (!apiKey) {
      res.status(503).end('Gallery API key not configured');
      return;
    }

    try {
      const coverRes = await fetch(
        `${galleryBaseUrl}/api/albums/${albumId}/og-cover`,
        {
          headers: {
            'user-agent': 'CanariLinkPreview/1.0',
            'x-api-key': apiKey,
          },
          signal: AbortSignal.timeout(6000),
        },
      );

      if (!coverRes.ok) {
        res.status(coverRes.status).end();
        return;
      }

      const contentType = coverRes.headers.get('content-type') || 'image/webp';
      const buffer = Buffer.from(await coverRes.arrayBuffer());

      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Content-Length', buffer.length);
      res.end(buffer);
    } catch {
      this.logger.warn(
        `[gallery-cover] Failed to fetch cover for album ${albumId}`,
      );
      res.status(502).end();
    }
  }
}
