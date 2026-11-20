import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Res,
  BadRequestException,
  ConflictException,
  BadGatewayException,
  InternalServerErrorException,
  ForbiddenException,
  UseGuards,
  Headers,
  Logger,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'crypto';
import { PinVerifier } from '../entities/pin-verifier.entity';
import { RevokedDevice } from '../entities/revoked-device.entity';
import { KeyPackage } from '../entities/key-package.entity';
import { MessagingService } from '../services/messaging.service';
import { HeaderAuthGuard } from '../guards/header-auth.guard';
import { UserThrottlerGuard } from '../guards/user-throttler.guard';
import { sanitizeQueryValue, sanitizeOptionalQueryValue } from '../utils/sanitize';
import {
  mintGifMediaTicket,
  mintPreviewTicket,
  requireTicketSecret,
  verifyPreviewTicket,
} from '../utils/previewTicket';
import { writeRelayedImageHeaders } from '../utils/gif-media';
import {
  assertSafeExternalUrl,
  fetchYouTubeOEmbed,
  fetchMiGalleryPreview,
  buildLinkPreviewPayload,
  extractOEmbedEndpoint,
  fetchOEmbedData,
  OEmbedUnavailable,
  mergeOEmbedIntoPayload,
  ssrfSafeFetch,
  errorCause,
  OUTBOUND_BUDGET_MS,
  UpstreamUnreachableError,
  type LinkPreviewPayload,
  type SsrfSafeResponse,
} from '../utils/url-guard';
import { checkSafeBrowsing } from '../utils/safe-browsing';
import { TtlCache } from '../utils/ttl-cache';
import { activeRevocationWhere } from '../utils/revocation';
import { RefusalCode, refusalBody } from '../utils/refusal-codes';
import { RouteParams } from '../common/route-params';

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

/** How many redirects a page fetch follows, and an image fetch (a CDN chains two or three). */
const PAGE_MAX_REDIRECTS = 3;
const IMAGE_MAX_REDIRECTS = 5;

/** Hard ceiling on what an image proxy will download, and on what it will retain. */
const IMAGE_MAX_BYTES = 3_000_000;
const IMAGE_CACHEABLE_BYTES = 256_000;

/**
 * The verifier of a PIN chosen before salts existed, once `GET pin-salt` gave its row a salt.
 *
 * That PIN's verifier was derived from a predictable salt the client no longer computes, so it can
 * never be compared again - but the account HAS a PIN, and answering its next unlock `not-set` would
 * tell someone who has typed it for months to choose a new one, twice. So the row keeps the FACT:
 * this value (never a 64-hex verifier, so it cannot collide with one) reads as registered in
 * `pin-status`, and the next `pin-check` under the new salt re-registers the PIN typed, whatever its
 * intent - what the pre-salt check always did for that population - logged as legacy. A dated shim:
 * `legacy-compatibility.md`, "A PIN from before salts re-registers on its next check".
 */
export const LEGACY_UNSALTED_VERIFIER = 'legacy-unsalted';

/** PIN verifier and link-preview (SSRF-protected) endpoints. */
@RouteParams({ userId: 'opaque' })
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
   * Authorises a PIN/security operation: the caller must be the target user themselves (matched on
   * the Nginx-injected `x-user-id` header). A global admin is not exempt (owner, 2026-11-02): a PIN
   * is its holder's alone, and a reset purges their device footprint. Throws
   * {@link ForbiddenException} otherwise.
   */
  private assertSelf(targetUserId: string, headerUserId?: string): void {
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
   *   { status: 'stale-salt' }  - the client derived its verifier from a salt this account no
   *                               longer holds; nothing was compared, stored or reset.
   *   { status: 'not-set' }     - the account has no PIN and the client asked to UNLOCK
   *                               (`intent: 'unlock'`): nothing was stored.
   *
   * A PIN IS REGISTERED ONLY WHEN THE CLIENT SAYS IT IS CREATING ONE (PIN audit, 2026-11-20). Every
   * check used to register on an account with no verifier, so a keypad drawn as "unlock" by mistake
   * (a device id minted by an abandoned setup, the placeholder row `pin-salt` writes) stored the first
   * PIN typed into it, never confirmed. `intent: 'create'` is sent by a client whose gate asked the
   * PIN twice; `intent: 'unlock'` is answered `not-set` and the client draws its first-setup gate. A
   * client sending NO intent (an app older than this) is answered as before - it registers - until
   * the client floor passes the version that sends one (`legacy-compatibility.md`).
   *
   * AND THE REGISTRATION IS ONE CONDITIONAL WRITE, pinned to the row that was read:
   * `UPDATE ... WHERE id = <read row> AND verifier = ''` on the placeholder, an
   * `INSERT ... ON CONFLICT DO NOTHING` on no row, the affected or returned rows deciding. A lost
   * write against a row since replaced (a reset, then a new salt) answers `stale-salt`. Two devices creating
   * at once used to both read the empty verifier and both save, both told `registered`, the row
   * keeping the last - the loser then compares, and is told `ok` or `mismatch` honestly.
   *
   * WHY `stale-salt` EXISTS: the salt only changes when a PIN reset deletes the row and the next
   * `pin-salt` GET mints a new one. A client that asked for the salt BEFORE that reset (the keypad
   * asks it while the person types) would otherwise send a verifier that cannot match - a correct
   * new PIN answered `mismatch` - or, with no row left at all, REGISTER a verifier under a salt the
   * server never stored, which the next GET then discards as a legacy row. The server is the only
   * side that knows the salt changed, so it says so, as a status, and the client asks again.
   * `salt` is optional: a client that does not send it is answered exactly as before.
   */
  @UseGuards(HeaderAuthGuard, UserThrottlerGuard)
  @Post('mls/security/pin-check')
  async checkPinVerifier(
    @Body()
    body: {
      userId: string;
      verifier: string;
      deviceId?: string;
      salt?: string;
      intent?: 'create' | 'unlock';
    },
    @Headers('x-user-id') headerUserId?: string
  ) {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelf(safeUserId, headerUserId);
    const safeVerifier = sanitizeQueryValue(body.verifier, 'verifier');
    const safeDeviceId = sanitizeOptionalQueryValue(body.deviceId, 'deviceId');

    // Verifier must be a 64-char lowercase hex string (32 bytes PBKDF2 output).
    if (!/^[0-9a-f]{64}$/.test(safeVerifier)) {
      throw new BadRequestException('verifier format invalid');
    }

    const safeSalt = sanitizeOptionalQueryValue(body.salt, 'salt');

    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
    });

    if (safeSalt !== undefined && doc?.salt !== safeSalt) {
      this.logger.log(
        `[PIN_VERIFIER] stale salt for ${safeUserId} (row ${doc ? 'holds another salt' : 'absent'}) - nothing compared`
      );
      return { status: 'stale-salt', resetRequired: false };
    }

    const intent = body.intent;
    if (intent !== undefined && intent !== 'create' && intent !== 'unlock') {
      throw new BadRequestException('intent invalid');
    }

    if (doc?.verifier === LEGACY_UNSALTED_VERIFIER) {
      this.logger.log(
        `[PIN_VERIFIER] legacy unsalted PIN of ${safeUserId} re-registered under its salt (intent ${intent ?? 'none'})`
      );
      return this.registerOrCompare(safeUserId, safeVerifier, doc);
    }

    if (!doc || !doc.verifier || doc.verifier.length === 0) {
      if (intent === 'unlock') {
        this.logger.log(`[PIN_VERIFIER] unlock asked for ${safeUserId} with no PIN set - not-set`);
        return { status: 'not-set', resetRequired: false };
      }
      if (intent === undefined) {
        this.logger.log(
          `[PIN_VERIFIER] legacy client (no intent) registering for ${safeUserId} - unconfirmed`
        );
      }
      return this.registerOrCompare(safeUserId, safeVerifier, doc);
    }

    if (typeof doc.verifier !== 'string') {
      throw new BadRequestException('stored verifier format invalid');
    }

    if (intent === undefined) {
      // MEASURES THE LEGACY SHIM (legacy-compatibility.md): an app that sends no intent also unlocks
      // with none, and its removal waits for these lines to fall silent too.
      this.logger.log(`[PIN_VERIFIER] legacy client (no intent) unlocking for ${safeUserId}`);
    }

    const match = this.verifierMatches(doc.verifier, safeVerifier);

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

  /** Constant-time comparison of two hex verifiers, to prevent timing-based inference. */
  private verifierMatches(storedHex: string, incomingHex: string): boolean {
    const stored = Buffer.from(storedHex, 'hex');
    const incoming = Buffer.from(incomingHex, 'hex');
    return stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming);
  }

  /**
   * Registers `verifier` as the account's PIN when the row is still what the caller READ, and
   * otherwise answers what the row now says.
   *
   * THE WRITE IS PINNED TO THE ROW AND THE VALUE THAT WERE READ: `UPDATE ... WHERE id = <read row>
   * AND verifier = <read verifier>` (the empty placeholder, or {@link LEGACY_UNSALTED_VERIFIER}) - a
   * row a reset deleted and a later `pin-salt` re-minted has another id, so a verifier derived from
   * the old salt never lands on the new one. With no row read: `INSERT ... ON CONFLICT DO NOTHING`, a
   * returned row deciding; a conflict fills nothing the caller did not read.
   *
   * A LOST WRITE: a row that is gone, replaced, or still unfilled means the salt the client derived
   * from is not the row's - `stale-salt`, and it asks again; otherwise another device registered
   * first, and this one is compared against what it stored.
   */
  private async registerOrCompare(
    userId: string,
    verifier: string,
    read: PinVerifier | null
  ): Promise<{ status: 'registered' | 'ok' | 'mismatch' | 'stale-salt'; resetRequired: false }> {
    let stored: boolean;
    if (read) {
      const filled = await this.pinVerifierRepo.update(
        { id: read.id, verifier: read.verifier },
        { verifier }
      );
      stored = (filled.affected ?? 0) === 1;
    } else {
      const inserted = await this.pinVerifierRepo
        .createQueryBuilder()
        .insert()
        .values({ userId, verifier })
        .orIgnore()
        .execute();
      stored = Array.isArray(inserted.raw) && inserted.raw.length > 0;
    }
    if (stored) return { status: 'registered', resetRequired: false };

    const now = await this.pinVerifierRepo.findOne({ where: { userId } });
    if (
      !now?.verifier ||
      now.verifier === LEGACY_UNSALTED_VERIFIER ||
      (read !== null && now.id !== read.id)
    ) {
      this.logger.log(
        `[PIN_VERIFIER] registration for ${userId} met another row (${now ? 'replaced or unfilled' : 'absent'}) - stale-salt`
      );
      return { status: 'stale-salt', resetRequired: false };
    }
    return {
      status: this.verifierMatches(now.verifier, verifier) ? 'ok' : 'mismatch',
      resetRequired: false,
    };
  }

  /**
   * Returns the account's PBKDF2 salt, minting it when there is none - IDEMPOTENTLY, from durable
   * state: every concurrent first GET answers the same salt.
   *
   * - A row with a salt: returned as it is.
   * - No row: `INSERT ... ON CONFLICT DO NOTHING` of a placeholder (empty verifier) under a fresh
   *   salt; on a conflict, the row another GET minted is read back and its salt returned.
   * - A legacy row (`salt IS NULL`, a PIN from before salts): given a fresh salt in one conditional
   *   write (`WHERE id = <read row> AND salt IS NULL`), and its verifier - derived from the old
   *   predictable salt, never comparable again - becomes {@link LEGACY_UNSALTED_VERIFIER}, so the
   *   account still reads as HAVING a PIN and its next check re-registers it. A legacy row with no
   *   verifier is a plain placeholder.
   *
   * A row that changed again between the lost write and the read back (a reset in between) is a
   * `409`: nothing is guessed, and the client asks again.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/security/pin-salt/:userId')
  async getPinSalt(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ salt: string }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    this.assertSelf(safeUserId, headerUserId);

    const doc = await this.pinVerifierRepo.findOne({ where: { userId: safeUserId } });
    if (doc?.salt) return { salt: doc.salt };

    const newSalt = crypto.randomBytes(16).toString('hex');
    let minted: boolean;
    if (doc) {
      const verifier = doc.verifier ? LEGACY_UNSALTED_VERIFIER : '';
      const salted = await this.pinVerifierRepo.update(
        { id: doc.id, salt: IsNull() },
        { salt: newSalt, verifier }
      );
      minted = (salted.affected ?? 0) === 1;
    } else {
      const inserted = await this.pinVerifierRepo
        .createQueryBuilder()
        .insert()
        .values({ userId: safeUserId, verifier: '', salt: newSalt })
        .orIgnore()
        .execute();
      minted = Array.isArray(inserted.raw) && inserted.raw.length > 0;
    }
    if (minted) {
      const what = !doc
        ? 'no row'
        : doc.verifier
          ? 'legacy row, its PIN kept as legacy-unsalted'
          : 'legacy row, no PIN chosen';
      this.logger.log(`[PIN_SALT] new salt minted for ${safeUserId} (${what})`);
      return { salt: newSalt };
    }

    // Another GET minted it first: its salt is the account's.
    const now = await this.pinVerifierRepo.findOne({ where: { userId: safeUserId } });
    if (now?.salt) return { salt: now.salt };
    this.logger.warn(`[PIN_SALT] the row of ${safeUserId} changed while its salt was minted - 409`);
    throw new ConflictException('pin salt changed concurrently');
  }

  /**
   * Reports whether the account HAS a PIN: a row with a NON-EMPTY verifier (a chosen PIN, or
   * {@link LEGACY_UNSALTED_VERIFIER} for one chosen before salts). The placeholder `GET pin-salt`
   * writes (an empty verifier) is not one. This is the source of truth for "first setup": the client
   * shows the "choose your PIN" flow only when `registered` is false. Unlike a device-count heuristic,
   * it stays correct for a user whose devices have all been revoked or garbage-collected.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/security/pin-status/:userId')
  async getPinStatus(
    @Param('userId') userId: string,
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ registered: boolean }> {
    const safeUserId = sanitizeQueryValue(userId, 'userId');
    this.assertSelf(safeUserId, headerUserId);
    // A NON-EMPTY verifier, never the row: `GET pin-salt` writes a placeholder with an empty one for
    // an account that has not chosen a PIN, and reading that as "registered" drew an unlock keypad
    // whose first PIN was then stored unconfirmed (PIN audit, 2026-11-20).
    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
      select: { id: true, verifier: true },
    });
    return { registered: !!doc?.verifier };
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
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ ok: boolean }> {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelf(safeUserId, headerUserId);

    const oldVerifier = sanitizeQueryValue(body.oldVerifier, 'oldVerifier');
    const newVerifier = sanitizeQueryValue(body.newVerifier, 'newVerifier');
    if (!/^[0-9a-f]{64}$/.test(oldVerifier) || !/^[0-9a-f]{64}$/.test(newVerifier)) {
      throw new BadRequestException('verifier format invalid');
    }

    const doc = await this.pinVerifierRepo.findOne({
      where: { userId: safeUserId },
    });
    if (!doc || typeof doc.verifier !== 'string') {
      throw new BadRequestException(
        refusalBody(RefusalCode.PIN_NOT_SET, 'no PIN registered for this user')
      );
    }

    const stored = Buffer.from(doc.verifier, 'hex');
    const incoming = Buffer.from(oldVerifier, 'hex');
    const matches = stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming);
    if (!matches) {
      throw new ForbiddenException(
        refusalBody(RefusalCode.PIN_INCORRECT, 'current PIN is incorrect')
      );
    }

    // A COMPARE-AND-SWAP, NOT A READ THEN A SAVE. Two devices (or two tabs) changing the PIN at once
    // both pass the check above against the same row; with a plain save the LAST one decided the
    // account's PIN while each device moved its local key to its own - one of them then locked out of
    // the PIN it had just set. The row moves only if it still holds the verifier just compared, so
    // the second change is refused like any other wrong current PIN.
    const swapped = await this.pinVerifierRepo.update(
      { userId: safeUserId, verifier: doc.verifier },
      { verifier: newVerifier }
    );
    if (!swapped.affected) {
      this.logger.warn(
        `[PIN_CHANGE] verifier for ${safeUserId} changed between the check and the write - refused`
      );
      throw new ForbiddenException(
        refusalBody(RefusalCode.PIN_INCORRECT, 'current PIN is incorrect')
      );
    }
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
    @Headers('x-user-id') headerUserId?: string
  ): Promise<{ ok: boolean; devicesPurged: number }> {
    const safeUserId = sanitizeQueryValue(body.userId, 'userId');
    this.assertSelf(safeUserId, headerUserId);

    // THE VERIFIER GOES FIRST, AND ITS DELETION IS THE RESET'S COMMIT POINT (round 9 of the review of
    // #2919). The client settles a reset whose answer it lost by comparing the account's salt with
    // the one it had before asking: the salt lives in this row, so "same salt" must prove that
    // NOTHING was done. Purging the devices first broke that - a reset cut after the purge left the
    // salt in place, and the client restored a state whose device footprint was already gone. The
    // purge spans Redis and other tables, so it cannot share a transaction with this delete; it runs
    // after it, per device, each failure accused, and the answer is a 5xx when one failed - which
    // the client reads by the salt, now gone, as a reset that happened.
    //
    // THE REVOCATIONS ONLY AFTER IT, never beside it (round 11): deleted together, a failed verifier
    // delete beside a committed revocations delete UN-REVOKED a stolen device while the PIN stayed.
    // A verifier delete that fails stops here, with nothing done; a revocations delete that fails
    // after it keeps the devices revoked - the safe side - and is accused like a failed purge.
    await this.pinVerifierRepo.delete({ userId: safeUserId });
    let failures = 0;
    try {
      await this.revokedDeviceRepo.delete({ userId: safeUserId });
    } catch (e) {
      failures++;
      this.logger.error(
        `[PIN_RESET] user=${safeUserId}: the PIN is reset but its device revocations were not cleared - those devices stay revoked: ${String(e)}`
      );
    }

    const devices = await this.keyPackageRepo.find({
      where: { userId: safeUserId },
      select: { deviceId: true },
    });
    const deviceIds = [...new Set(devices.map((d) => d.deviceId))];

    let devicesPurged = 0;
    let purgeFailures = 0;
    for (const deviceId of deviceIds) {
      try {
        await this.messagingService.purgeDeviceFootprint(safeUserId, deviceId);
        devicesPurged++;
      } catch (e) {
        purgeFailures++;
        this.logger.error(
          `[PIN_RESET] user=${safeUserId} device=${deviceId}: the PIN is reset but this device's footprint was not purged: ${String(e)}`
        );
      }
    }

    this.logger.log(
      `[PIN_RESET] user=${safeUserId} devicesPurged=${devicesPurged} purgeFailures=${purgeFailures} (GroupMember rows kept for re-add)`
    );
    if (purgeFailures + failures > 0) {
      throw new InternalServerErrorException(
        `the PIN is reset; ${purgeFailures} device footprint(s) could not be purged, revocations ${failures > 0 ? 'not cleared' : 'cleared'}`
      );
    }

    return { ok: true, devicesPurged };
  }

  /**
   * Mints the ticket `mls/link-preview/image` accepts, for a caller nginx has identified.
   *
   * It is its own route rather than a field on the preview payload because the client proxies more
   * images than the payload names: the favicon chain is derived client-side from the page URL, so
   * anything signed per-URL server-side would cover the cover image and none of the favicons.
   *
   * `gifTicket` rides along for `mls/gifs/media`, the GIF relay: one authenticated call for both,
   * and a separate kind because its bucket is a day (see `GIF_MEDIA_TICKET_BUCKET_MS`). The client
   * re-reads it with every preview ticket, and its value changes once a day.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/link-preview/ticket')
  getLinkPreviewTicket(): { ticket: string; expiresInMs: number; gifTicket: string } {
    const secret = requireTicketSecret();
    return { ...mintPreviewTicket(secret), gifTicket: mintGifMediaTicket(secret).ticket };
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
   *
   * GUARDED since 2026-09-10. It is SSRF-protected, which decides what it may be pointed at and
   * nothing about who may point it: measured that day, a caller with no session at all had a
   * server-side fetcher that downloaded an arbitrary page and handed back its parsed contents.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/link-preview')
  async getLinkPreview(
    @Query('url') url: string,
    @Res({ passthrough: true }) res: ExpressResponse
  ) {
    if (!url || typeof url !== 'string') {
      throw new BadRequestException('url is required');
    }

    const targetUrl = await this.guardOrBadGateway(url, 'LINK_PREVIEW', res);
    const cacheKey = targetUrl.toString();

    const cached = SecurityController.previewCache.get(cacheKey);
    if (cached) {
      this.logger.debug(`[LINK_PREVIEW] cache hit ${targetUrl.hostname} ok=${cached.ok}`);
      if (cached.ok === false) throw new BadRequestException(cached.message);
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(PREVIEW_TTL_MS / 1000)}`);
      return cached.payload;
    }

    // The whole operation, redirect chain and oEmbed follow-up included. Each individual leg is
    // bounded by the same number on the dispatcher, so the two mechanisms cannot disagree.
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), OUTBOUND_BUDGET_MS);

    try {
      const payload = await this.resolveLinkPreview(targetUrl, abortController.signal);
      SecurityController.previewCache.set(cacheKey, { ok: true, payload }, PREVIEW_TTL_MS);
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(PREVIEW_TTL_MS / 1000)}`);
      return payload;
    } catch (error) {
      // ONLY AN ANSWER MAY BE CACHED, AND ONLY AN ANSWER MAY BE A 400.
      //
      // The site answering something unusable - a 404, a non-HTML body, a page too large, a
      // redirect to a private address - is a fact about this URL. It is worth remembering for a
      // tenth of the success TTL, because without it every render of a message pointing at a dead
      // host pays the full budget again.
      if (error instanceof BadRequestException) {
        SecurityController.previewCache.set(
          cacheKey,
          { ok: false, message: error.message },
          PREVIEW_FAILURE_TTL_MS
        );
        throw error;
      }

      // Not reaching the host is not a fact about the URL. Measured on 2026-08-15: one Wikipedia
      // connect timeout was stored as a refusal and replayed as `400` to every reader for ten
      // minutes, for a page that answered normally six minutes later - `cache hit ... ok=true` in
      // the same log. Nothing is stored, the next request tries again, and the status says which
      // side failed instead of blaming the request.
      if (error instanceof UpstreamUnreachableError) {
        this.logger.warn(`[LINK_PREVIEW] ${error.message}`);
        res.setHeader('Cache-Control', 'no-store');
        throw new BadGatewayException('Link preview upstream unreachable');
      }

      // Anything else is OURS - a parser fault, a bug in this file. It is neither cached nor
      // reported as the caller's mistake, and it is logged at a level that says so.
      this.logger.error(
        `[LINK_PREVIEW] ${targetUrl.hostname} raised an unexpected error: ${String(errorCause(error) ?? error)}`
      );
      res.setHeader('Cache-Control', 'no-store');
      throw new InternalServerErrorException('Link preview failed');
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
   * GUARDED since 2026-09-10, and the reasoning it used to carry was wrong in the half that
   * mattered. "The answer is not sensitive" is true and decides nothing: what an anonymous caller
   * got out of it was a Google Safe Browsing lookup on Canari's quota, for any URL, for free.
   */
  @UseGuards(HeaderAuthGuard)
  @Get('mls/link-safety')
  async getLinkSafety(@Query('url') url: string, @Res({ passthrough: true }) res: ExpressResponse) {
    if (!url || typeof url !== 'string') {
      throw new BadRequestException('url is required');
    }

    const targetUrl = await this.guardOrBadGateway(url, 'LINK_SAFETY', res);
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
   * The SSRF guard of a JSON endpoint, its one unreachable outcome answered here: a resolver that
   * said nothing (`EAI_AGAIN`, typed {@link UpstreamUnreachableError} at the throw) is a `502` that
   * nothing caches and a WARN naming the host and the resolver code - never the `500` and ERROR
   * stack Nest's `ExceptionsHandler` printed for it, since it is neither the request's fault nor a
   * bug. A refused URL (`BadRequestException`) passes through as the caller's `400`.
   */
  private async guardOrBadGateway(url: string, scope: string, res: ExpressResponse): Promise<URL> {
    try {
      return await assertSafeExternalUrl(url);
    } catch (error) {
      if (!(error instanceof UpstreamUnreachableError)) throw error;
      this.logger.warn(`[${scope}] ${error.message}`);
      res.setHeader('Cache-Control', 'no-store');
      throw new BadGatewayException('Link upstream unreachable');
    }
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
    // CLASSIFIED AT THE THROW, NOT BY ITS MESSAGE. Every outbound call in this method goes through
    // `reachOr`, so the endpoint above can tell "the site said something unusable" from "the site
    // said nothing" by TYPE - the two differ in whether the answer may be remembered, and no
    // wording can carry that distinction to a caller.
    const reachOr = async <T>(what: () => Promise<T>): Promise<T> => {
      try {
        return await what();
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        throw new UpstreamUnreachableError(targetUrl.hostname, error);
      }
    };

    // The YouTube short-circuit stays ahead of the generic oEmbed discovery
    // below: it needs no HTML fetch at all, so it is strictly cheaper.
    const youtubePayload = await reachOr(() => fetchYouTubeOEmbed(targetUrl, signal));
    if (youtubePayload) {
      return youtubePayload;
    }

    const galleryPayload = await reachOr(() => fetchMiGalleryPreview(targetUrl));
    if (galleryPayload) {
      return galleryPayload;
    }

    const { response, servedFrom: currentUrl } = await this.fetchThroughCheckedHops(
      targetUrl,
      { signal, accept: 'text/html,application/xhtml+xml', maxRedirects: PAGE_MAX_REDIRECTS },
      reachOr
    );

    if (!response.ok) {
      throw new BadRequestException('Unable to fetch URL');
    }
    // Bound to a const so the narrowing survives into the closure below - `response` is a `let`
    // written inside the loop, and TypeScript rightly refuses to carry a narrowing across that.
    const page = response;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) {
      throw new BadRequestException('URL is not an HTML page');
    }

    const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
    if (Number.isFinite(contentLength) && contentLength > 1_000_000) {
      throw new BadRequestException('Page is too large to preview');
    }

    // Reading the body can still fail on the wire (a socket that dies mid-transfer, the body
    // deadline elapsing), and that is the same class as never having connected.
    const html = (await reachOr(() => page.text())).slice(0, 220_000);
    // `currentUrl` is where this HTML came from and `targetUrl` is the link the message wrote;
    // the redirect loop above is exactly what makes them differ. Every relative reference in the
    // markup - image, icon, oEmbed href - belongs to the page that answered, and resolving one
    // against the link instead is what built `https://bit.ly/files/event/1461421.jpg`.
    const payload = buildLinkPreviewPayload(html, targetUrl, currentUrl);

    // Follow the page's own oEmbed endpoint when it declares one. It is the
    // contract a site publishes for embedders, so it covers Spotify, Vimeo,
    // Bandcamp and X through one code path - and it only ever fills gaps, so a
    // page with good Open Graph tags is never made worse by it.
    const oembedEndpoint = extractOEmbedEndpoint(html, currentUrl);
    if (!oembedEndpoint) return payload;

    const oembed = await fetchOEmbedData(oembedEndpoint, signal);
    if (oembed instanceof OEmbedUnavailable) {
      // The preview is served either way. A page pointing us somewhere the guard refuses, or an
      // endpoint that said nothing, is worth a WARN; a third party's unusable answer is a fact
      // about its site nobody here can act on. Logged once per resolution - the preview is cached.
      const line = `[LINK_PREVIEW] oEmbed of ${targetUrl.hostname} not used (${oembed.kind}): ${oembed.detail}`;
      if (oembed.kind === 'refused' || oembed.kind === 'unreachable') this.logger.warn(line);
      else this.logger.debug(line);
      return payload;
    }
    this.logger.debug(`[LINK_PREVIEW] oEmbed enriched ${targetUrl.hostname}`);
    return mergeOEmbedIntoPayload(payload, oembed, targetUrl, currentUrl);
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
   * A TICKET, NOT A GUARD, AND THE DIFFERENCE IS THE `<img>`. This URL goes into an `<img src>`,
   * so the browser makes the request itself and carries no `Authorization` header - and on
   * `tauri://localhost` no cookie either. `HeaderAuthGuard` would refuse every mobile reader.
   *
   * It used to say it was unauthenticated on purpose, on the grounds that it "holds no credential,
   * so requiring a session would buy nothing". What it bought anybody, measured 2026-09-10, was an
   * image proxy: 5430 bytes of a Google favicon relayed with no session, on Canari's address and
   * Canari's bandwidth. So the caller is now identified one step earlier, by a ticket an
   * authenticated call mints - see `utils/previewTicket`.
   */
  @Get('mls/link-preview/image')
  async getLinkPreviewImage(
    @Query('url') url: string,
    @Query('t') ticket: string,
    @Res() res: ExpressResponse
  ): Promise<void> {
    // BODYLESS, like every other refusal on this route: the response is decoded by an `<img>`, and
    // a JSON body handed to an image destination is what produces three console lines for one
    // benign miss.
    if (!verifyPreviewTicket(ticket, requireTicketSecret())) {
      res.status(401).end();
      return;
    }

    if (!url || typeof url !== 'string') {
      res.status(400).end('url is required');
      return;
    }

    let targetUrl: URL;
    try {
      targetUrl = await assertSafeExternalUrl(url);
    } catch (error) {
      // The resolver saying nothing is not the URL's fault: a 502, as for a fetch that failed.
      if (error instanceof UpstreamUnreachableError) {
        this.logger.warn(`[LINK_PREVIEW_IMAGE] ${error.message}`);
        res.status(502).end();
        return;
      }
      // Reachable: the guard rethrows what is not the resolver's answer - a bug, left to surface.
      if (!(error instanceof BadRequestException)) throw error;
      this.logger.debug(`[LINK_PREVIEW_IMAGE] refused: ${error.message}`);
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
      // Walked hop by hop like the page fetch, each hop judged before it is fetched. A CDN
      // answers an image request with two or three redirects, hence the larger allowance.
      const { response } = await this.fetchThroughCheckedHops(targetUrl, {
        signal: AbortSignal.timeout(5000),
        accept: 'image/*',
        maxRedirects: IMAGE_MAX_REDIRECTS,
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

  /**
   * Fetches `start` and follows its redirects ONE HOP AT A TIME, each target passed through
   * `assertSafeExternalUrl` before anything is sent to it - the one way every outbound preview
   * fetch of this controller walks a redirect chain, page and image alike. The connect-time guard
   * of `ssrfSafeFetch` judges what a NAME resolves to; a hop written as an address has no name
   * to resolve, so the check that covers it is this one.
   *
   * @param around - wraps each network leg, so the page fetch can classify an unreachable host
   * @returns the last response (a 3xx when the allowance ran out or a hop named no location) and
   *   the URL it was served from
   * @throws BadRequestException when a hop is not a public http(s) URL
   */
  private async fetchThroughCheckedHops(
    start: URL,
    options: { signal: AbortSignal; accept: string; maxRedirects: number },
    around: <T>(leg: () => Promise<T>) => Promise<T> = (leg) => leg()
  ): Promise<{ response: SsrfSafeResponse; servedFrom: URL }> {
    let currentUrl = start;
    for (let redirects = 0; ; redirects++) {
      // Security: mitigates CodeQL alerts #2464 and #2479 - re-validate URL immediately
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
      const response = await around(() =>
        ssrfSafeFetch(fetchUrl, {
          method: 'GET',
          redirect: 'manual', // every hop comes back here to be judged
          signal: options.signal,
          headers: { 'user-agent': 'CanariLinkPreview/1.0', accept: options.accept },
        })
      );

      const location =
        response.status >= 300 && response.status <= 399 ? response.headers.get('location') : null;
      if (!location || redirects >= options.maxRedirects) {
        this.logger.debug(
          `[LINK_PREVIEW] ${start.hostname} answered ${response.status} after ${redirects} redirect(s)`
        );
        return { response, servedFrom: currentUrl };
      }
      // A redirect's own body is never read: cancel it so its connection is released now.
      await response.body?.cancel().catch((e: unknown) => {
        this.logger.debug(
          `[LINK_PREVIEW] ${currentUrl.hostname} redirect body cancel: ${String(e)}`
        );
      });
      // Re-validate the redirect target against SSRF (e.g. a redirect to localhost).
      currentUrl = await assertSafeExternalUrl(new URL(location, currentUrl.href).toString());
    }
  }

  /** Writes a proxied image with the headers that let the browser stop asking. */
  private sendProxiedImage(res: ExpressResponse, image: CachedImage): void {
    writeRelayedImageHeaders(res, {
      contentType: image.contentType,
      length: image.body.length,
      cacheControl: `public, max-age=${Math.floor(IMAGE_TTL_MS / 1000)}`,
    });
    res.end(image.body);
  }
}
