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
import { ThrottlerGuard } from '@nestjs/throttler';
import { sanitizeQueryValue, sanitizeOptionalQueryValue } from '../utils/sanitize';
import {
  assertSafeExternalUrl,
  fetchYouTubeOEmbed,
  fetchMiGalleryPreview,
  buildLinkPreviewPayload,
  extractOEmbedEndpoint,
  fetchOEmbedData,
  mergeOEmbedIntoPayload,
  ssrfSafeFetch,
  errorCause,
  type LinkPreviewPayload,
  type SsrfSafeResponse,
} from '../utils/url-guard';
import { checkSafeBrowsing } from '../utils/safe-browsing';
import { TtlCache } from '../utils/ttl-cache';
import { activeRevocationWhere } from '../utils/revocation';

/** A preview we managed to build, or the fact that we could not. */
type CachedPreview = { ok: true; payload: LinkPreviewPayload } | { ok: false; message: string };

/** A proxied image, small enough to be worth holding on to. */
interface CachedImage {
  contentType: string;
  body: Buffer;
}

/**
 * How long an answer is reused. Six hours for a page that answered, because
 * Open Graph tags change on the scale of an edit, not of a render; ten minutes
 * for a failure, so a site that was merely down is retried the same day rather
 * than written off for six hours.
 */
const PREVIEW_TTL_MS = 6 * 60 * 60 * 1000;
const PREVIEW_FAILURE_TTL_MS = 10 * 60 * 1000;
const IMAGE_TTL_MS = 6 * 60 * 60 * 1000;

/** Hard ceiling on what an image proxy will download, and on what it will retain. */
const IMAGE_MAX_BYTES = 3_000_000;
const IMAGE_CACHEABLE_BYTES = 256_000;

/** PIN verifier and link-preview (SSRF-protected) endpoints. */
@Controller()
export class SecurityController {
  private readonly logger = new Logger(SecurityController.name);

  /**
   * Keyed by the requested URL, and shared by every reader on every device -
   * one person sharing a link produces a burst of identical requests, which is
   * exactly the case a cache is for. Static rather than an instance field so
   * the lifetime is the process's, not the controller's.
   */
  private static readonly previewCache = new TtlCache<CachedPreview>(500);
  private static readonly imageCache = new TtlCache<CachedImage>(200);
  /** Keyed the same way as previewCache, but independent of it: a Safe Browsing verdict must
   * survive even when the metadata fetch it would otherwise ride along with fails (WP-SAFELINK-1). */
  private static readonly safeBrowsingCache = new TtlCache<boolean>(1000);

  constructor(
    @InjectRepository(PinVerifier)
    private pinVerifierRepo: Repository<PinVerifier>,
    @InjectRepository(RevokedDevice)
    private revokedDeviceRepo: Repository<RevokedDevice>,
    @InjectRepository(KeyPackage)
    private keyPackageRepo: Repository<KeyPackage>,
    private readonly messagingService: MessagingService
  ) {}

  /**
   * Authorises a PIN/security operation: the caller must be the target user
   * themselves (matched on the Nginx-injected `x-user-id` header) or a global
   * admin. Throws {@link ForbiddenException} otherwise.
   */
  private assertSelfOrGlobalAdmin(
    targetUserId: string,
    headerUserId?: string,
    headerGlobalAdmin?: string
  ): void {
    if (headerGlobalAdmin === 'true') return;
    const caller = sanitizeOptionalQueryValue(headerUserId, 'x-user-id');
    if (!caller || caller.trim().toLowerCase() !== targetUserId.trim().toLowerCase()) {
      throw new ForbiddenException('Operation restricted to the authenticated user');
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
  @UseGuards(ThrottlerGuard, HeaderAuthGuard)
  @Post('mls/security/pin-check')
  async checkPinVerifier(
    @Body() body: { userId: string; verifier: string; deviceId?: string },
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
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

    if (!doc || !doc.verifier || doc.verifier.length === 0) {
      if (doc) {
        // Placeholder row created by pin-salt: update the verifier on the existing entity
        doc.verifier = safeVerifier;
        await this.pinVerifierRepo.save(doc);
      } else {
        // First registration: create a new row
        const newDoc = this.pinVerifierRepo.create({
          userId: safeUserId,
          verifier: safeVerifier,
        });
        await this.pinVerifierRepo.save(newDoc);
      }
      return { status: 'registered', resetRequired: false };
    }

    if (typeof doc.verifier !== 'string') {
      throw new BadRequestException('stored verifier format invalid');
    }

    // Constant-time comparison to prevent timing-based inference.
    const stored = Buffer.from(doc.verifier, 'hex');
    const incoming = Buffer.from(safeVerifier, 'hex');
    const match = stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming);

    let resetRequired = false;
    if (match && safeDeviceId) {
      const revoked = await this.revokedDeviceRepo.findOne({
        where: activeRevocationWhere({ userId: safeUserId, deviceId: safeDeviceId }),
      });
      if (revoked) {
        // One-shot reset: signal the client once, then clear marker so the
        // same physical device can register again as a fresh device.
        await this.revokedDeviceRepo.delete(revoked.id);
        resetRequired = true;
        this.logger.log(`[PIN_VERIFIER] one-shot reset required for ${safeUserId}:${safeDeviceId}`);
      }
    }

    return { status: match ? 'ok' : 'mismatch', resetRequired };
  }

  /**
   * Returns the PBKDF2 salt for the user so the client can compute the PIN
   * verifier with a per-user random salt instead of a predictable one.
   * On first call for a user without a salt, generates a fresh 16-byte hex salt,
   * stores it alongside a placeholder verifier, and returns it.
   * For legacy rows (salt = null), invalidates the old verifier by replacing the row
   * so the next pin-check forces a clean re-registration with the new salt.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/security/pin-salt/:userId')
  async getPinSalt(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string,
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ salt: string }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);

    let doc = await this.pinVerifierRepo.findOne({ where: { userId: safeUserId } });

    // Existing user with a salt already set — return it as-is
    if (doc?.salt) {
      return { salt: doc.salt };
    }

    // Legacy user (salt = null) or no row yet: generate a fresh salt.
    // For legacy users, delete the old row so the next pin-check treats it as a
    // clean registration (the verifier was computed with the old predictable salt,
    // so it would never match a verifier derived from the new random salt).
    const newSalt = crypto.randomBytes(16).toString('hex');
    if (doc) {
      await this.pinVerifierRepo.delete({ userId: safeUserId });
    }
    await this.pinVerifierRepo.save(
      this.pinVerifierRepo.create({ userId: safeUserId, verifier: '', salt: newSalt })
    );
    this.logger.log(`[PIN_SALT] new salt generated for ${safeUserId} (legacy=${!!doc})`);

    return { salt: newSalt };
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
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ registered: boolean }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);
    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
      select: { id: true },
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
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ ok: boolean }> {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);

    const oldVerifier = sanitizeQueryValue(body.oldVerifier, 'oldVerifier');
    const newVerifier = sanitizeQueryValue(body.newVerifier, 'newVerifier');
    if (!/^[0-9a-f]{64}$/.test(oldVerifier) || !/^[0-9a-f]{64}$/.test(newVerifier)) {
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
    const matches = stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming);
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
    @Headers('x-global-admin') headerGlobalAdmin?: string
  ): Promise<{ ok: boolean; devicesPurged: number }> {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelfOrGlobalAdmin(safeUserId, headerUserId, headerGlobalAdmin);

    const devices = await this.keyPackageRepo.find({
      where: { userId: safeUserId },
      select: { deviceId: true },
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
      `[PIN_RESET] user=${safeUserId} devicesPurged=${devicesPurged} (GroupMember rows kept for re-add)`
    );

    return { ok: true, devicesPurged };
  }

  /**
   * Fetches a safe external URL preview (SSRF-protected: private IPs and
   * localhost are rejected), answering from cache when it can.
   *
   * The cache is what makes this endpoint honest towards the sites it reads:
   * every render of every message used to re-download the remote page, so a
   * conversation scrolled back through hammered a site that never agreed to
   * any of it. `Cache-Control` carries the same decision to the browser, which
   * is the only way to stop the request being made at all.
   */
  @Get('mls/link-preview')
  async getLinkPreview(
    @Query('url') url: string,
    @Res({ passthrough: true }) res: ExpressResponse
  ) {
    if (!url || typeof url !== 'string') {
      throw new BadRequestException('url is required');
    }

    const targetUrl = await assertSafeExternalUrl(url);
    const cacheKey = targetUrl.toString();

    const cached = SecurityController.previewCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`[LINK_PREVIEW] cache hit ${targetUrl.hostname} ok=${cached.ok}`);
      if (cached.ok === false) throw new BadRequestException(cached.message);
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(PREVIEW_TTL_MS / 1000)}`);
      return cached.payload;
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 4000);

    try {
      const payload = await this.resolveLinkPreview(targetUrl, abortController.signal);
      SecurityController.previewCache.set(cacheKey, { ok: true, payload }, PREVIEW_TTL_MS);
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(PREVIEW_TTL_MS / 1000)}`);
      return payload;
    } catch (error) {
      // A refusal is cached too, for a tenth of the time: without it every
      // render of a message pointing at a dead host pays the full timeout.
      const message = error instanceof BadRequestException ? error.message : 'Link preview failed';
      SecurityController.previewCache.set(cacheKey, { ok: false, message }, PREVIEW_FAILURE_TTL_MS);

      if (error instanceof BadRequestException) throw error;
      // The client only ever sees "Link preview failed", so without this line a
      // transport-level break (a dispatcher the runtime rejects, a DNS failure)
      // is indistinguishable from a site that simply refused us.
      const cause = errorCause(error) ?? error;
      this.logger.warn(`[LINK_PREVIEW] ${targetUrl.hostname} failed: ${String(cause)}`);
      throw new BadRequestException(message);
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Whether a URL is flagged by Google Safe Browsing (WP-SAFELINK-1) - deliberately its own
   * endpoint rather than a field folded into `getLinkPreview`'s response. The two checks have
   * unrelated failure modes: a page with a broken `<title>` or a redirect loop makes
   * `getLinkPreview` throw and return nothing at all, which would silently take the safety
   * verdict down with it if the two were coupled. A caller that only wants "is this safe to
   * open" (`AppLink`) should never depend on whether the site also has good Open Graph tags.
   *
   * Unauthenticated by design, same reasoning as `getLinkPreview`: it only ever answers about a
   * URL that has already passed `assertSafeExternalUrl`, and the answer itself (a boolean) is not
   * sensitive.
   */
  @Get('mls/link-safety')
  async getLinkSafety(@Query('url') url: string, @Res({ passthrough: true }) res: ExpressResponse) {
    if (!url || typeof url !== 'string') {
      throw new BadRequestException('url is required');
    }

    const targetUrl = await assertSafeExternalUrl(url);
    const cacheKey = targetUrl.toString();

    const cached = SecurityController.safeBrowsingCache.get(cacheKey);
    if (cached !== undefined) {
      return { unsafe: cached };
    }

    const verdict = await checkSafeBrowsing(targetUrl.toString());
    SecurityController.safeBrowsingCache.set(cacheKey, verdict.flagged, verdict.cacheTtlMs);
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(verdict.cacheTtlMs / 1000)}`);
    return { unsafe: verdict.flagged };
  }

  /**
   * Builds the preview for an already-validated URL. Split out of the endpoint
   * so caching and error mapping live in one place and the fetching logic in
   * another; it throws exactly what the endpoint is written to catch.
   */
  private async resolveLinkPreview(
    targetUrl: URL,
    signal: AbortSignal
  ): Promise<LinkPreviewPayload> {
    // The YouTube short-circuit stays ahead of the generic oEmbed discovery
    // below: it needs no HTML fetch at all, so it is strictly cheaper.
    const youtubePayload = await fetchYouTubeOEmbed(targetUrl);
    if (youtubePayload) {
      return youtubePayload;
    }

    const galleryPayload = await fetchMiGalleryPreview(targetUrl);
    if (galleryPayload) {
      return galleryPayload;
    }

    let currentUrl = targetUrl;
    let response: SsrfSafeResponse | null = null;
    let redirectsCount = 0;
    const MAX_REDIRECTS = 3;

    while (redirectsCount <= MAX_REDIRECTS) {
      // Security: mitigates CodeQL alerts #2464 and #2479 — re-validate URL immediately
      // before fetch, then reconstruct the string from validated URL parts to explicitly
      // break the taint chain for static analysis (CodeQL js/request-forgery).
      await assertSafeExternalUrl(currentUrl.href);
      const fetchUrl = new URL(
        currentUrl.pathname + currentUrl.search + currentUrl.hash,
        currentUrl.origin
      ).href;
      // ssrfSafeFetch pins the connection to a re-validated, public-only IP at
      // connect time (defends against DNS-rebinding between the check above and
      // this fetch). It must stay undici's own fetch - see its doc comment.
      response = await ssrfSafeFetch(fetchUrl, {
        method: 'GET',
        redirect: 'manual', // prevent automatic redirects
        signal,
        headers: {
          'user-agent': 'CanariLinkPreview/1.0',
          accept: 'text/html,application/xhtml+xml',
        },
      });

      // Manually handle redirects.
      if (response.status >= 300 && response.status <= 399) {
        const location = response.headers.get('location');
        if (!location) break;
        // Re-validate the redirect target against SSRF (e.g. a redirect to localhost).
        currentUrl = await assertSafeExternalUrl(new URL(location, currentUrl.href).toString());
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

    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
      throw new BadRequestException('Page is too large to preview');
    }

    const html = (await response.text()).slice(0, 220_000);
    const payload = buildLinkPreviewPayload(html, targetUrl);

    // Follow the page's own oEmbed endpoint when it declares one. It is the
    // contract a site publishes for embedders, so it covers Spotify, Vimeo,
    // Bandcamp and X through one code path - and it only ever fills gaps, so a
    // page with good Open Graph tags is never made worse by it.
    const oembedEndpoint = extractOEmbedEndpoint(html, targetUrl);
    if (!oembedEndpoint) return payload;

    const oembed = await fetchOEmbedData(oembedEndpoint, signal);
    if (oembed) {
      this.logger.debug(`[LINK_PREVIEW] oEmbed enriched ${targetUrl.hostname}`);
    }
    return mergeOEmbedIntoPayload(payload, oembed, targetUrl);
  }

  /**
   * Proxies the image of a link preview - its `og:image` or its favicon.
   *
   * The card used to point an `<img src>` straight at the remote host, so every
   * reader of a message opened a connection to a third party from inside an
   * end-to-end encrypted conversation: the site learned each reader's IP, their
   * user agent, and the moment they scrolled to the message. Encrypting the
   * body and then fetching the illustration in clear defeats a good part of
   * what the encryption is for. Fetching it here means the site sees the server
   * once per six hours instead of every reader every time.
   *
   * The URL is caller-supplied, so it goes through the same SSRF guard as the
   * page fetch, and the answer must actually be an image: a `text/html` body
   * served to an `<img>` is a site answering something other than what was
   * asked, and there is no reason to relay it.
   *
   * Unauthenticated on purpose, like the preview endpoint it serves: it fetches
   * only public URLs and holds no credential, so requiring a session would buy
   * nothing and break the preview for a page rendered before the session is up.
   */
  @Get('mls/link-preview/image')
  async getLinkPreviewImage(@Query('url') url: string, @Res() res: ExpressResponse): Promise<void> {
    if (!url || typeof url !== 'string') {
      res.status(400).end('url is required');
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = await assertSafeExternalUrl(url);
    } catch {
      res.status(400).end('Invalid or blocked URL');
      return;
    }

    const cacheKey = targetUrl.toString();
    const cached = SecurityController.imageCache.get(cacheKey);
    if (cached) {
      this.sendProxiedImage(res, cached);
      return;
    }

    try {
      const response = await ssrfSafeFetch(cacheKey, {
        method: 'GET',
        // Redirects are followed rather than walked by hand, unlike the page
        // fetch above: a CDN answers image requests with two or three of them,
        // and the dispatcher re-validates the resolved address at every connect,
        // so a redirect to a private host is refused at the socket regardless.
        redirect: 'follow',
        signal: AbortSignal.timeout(5000),
        headers: {
          'user-agent': 'CanariLinkPreview/1.0',
          accept: 'image/*',
        },
      });

      if (!response.ok) {
        res.status(response.status === 404 ? 404 : 502).end();
        return;
      }

      const contentType = (response.headers.get('content-type') || '').toLowerCase();
      // `image/*` only. An SVG is excluded with it: it is a document that can
      // carry script, and it would be served from our own origin.
      if (!contentType.startsWith('image/') || contentType.includes('svg')) {
        res.status(415).end();
        return;
      }

      const declaredLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
      if (Number.isFinite(declaredLength) && declaredLength > IMAGE_MAX_BYTES) {
        res.status(413).end();
        return;
      }

      const body = Buffer.from(await response.arrayBuffer());
      // A missing or lying `content-length` is why this is checked twice.
      if (body.length > IMAGE_MAX_BYTES) {
        res.status(413).end();
        return;
      }

      const image: CachedImage = { contentType: contentType.split(';')[0], body };
      // Only small images are retained: a favicon costs a kilobyte and is asked
      // for constantly, while a full-size og:image would evict a hundred of
      // them to save one request.
      if (body.length <= IMAGE_CACHEABLE_BYTES) {
        SecurityController.imageCache.set(cacheKey, image, IMAGE_TTL_MS);
      }
      this.sendProxiedImage(res, image);
    } catch (error) {
      const cause = errorCause(error) ?? error;
      this.logger.warn(`[LINK_PREVIEW_IMAGE] ${targetUrl.hostname} failed: ${String(cause)}`);
      res.status(502).end();
    }
  }

  /** Writes a proxied image with the headers that let the browser stop asking. */
  private sendProxiedImage(res: ExpressResponse, image: CachedImage): void {
    res.setHeader('Content-Type', image.contentType);
    res.setHeader('Content-Length', image.body.length);
    res.setHeader('Cache-Control', `public, max-age=${Math.floor(IMAGE_TTL_MS / 1000)}`);
    // The bytes come from a third party: refuse to let a browser sniff them
    // into anything other than the image type declared above.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(image.body);
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
    @Res() res: ExpressResponse
  ): Promise<void> {
    if (!albumId || !/^[0-9a-f-]{36}$/i.test(albumId)) {
      res.status(400).end('Invalid album ID');
      return;
    }

    const galleryBaseUrl = (process.env.MIGALLERY_API_URL || 'https://gallery.mitv.fr').replace(
      /\/$/,
      ''
    );
    const apiKey = process.env.MIGALLERY_API_KEY || '';

    if (!apiKey) {
      res.status(503).end('Gallery API key not configured');
      return;
    }

    try {
      const coverRes = await fetch(`${galleryBaseUrl}/api/albums/${albumId}/og-cover`, {
        headers: {
          'user-agent': 'CanariLinkPreview/1.0',
          'x-api-key': apiKey,
        },
        signal: AbortSignal.timeout(6000),
      });

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
      this.logger.warn(`[gallery-cover] Failed to fetch cover for album ${albumId}`);
      res.status(502).end();
    }
  }
}
