import {
  Body,
  Controller,
  Get,
  Headers,
  Post,
  HttpCode,
  Param,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Logger,
  NotFoundException,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import type { WireLineItem } from './payment-provider.interface';
import { parseLydiaOrderRef } from './lydia-order-ref';
import axios from 'axios';
import { internalSocialRequestConfig, internalPaymentAccountUrl } from './social-internal-client';
import { socialUrl } from '../internal/service-urls';
import { describeHttpError } from '../common/http-error-log';
import { assertCanManageAssociation } from './manage-permission';
import { LydiaCashierOps } from './lydia-cashier-ops';
import {
  LYDIA_CASHIER_ADD_ENABLED,
  LYDIA_CASHIER_PHONE_INVALID,
  LYDIA_CASHIER_PHONE_RE,
  LYDIA_ONBOARDING_STEP_TIMEOUT_MS,
  LYDIA_UNREACHABLE,
  LydiaCashierAddedUnconfirmedException,
  PAYMENT_PROVIDER_REFUSED,
  businessCreatedUnlinked,
} from './lydia-payment-provider';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Deliberately loose: the provider is the authority on deliverability, this only refuses junk. */
/**
 * Shape of a payer e-mail. Domain labels exclude the dot so every dot has ONE reading (the old
 * `[^\s@]+\.[^\s@]+` could split a run of dots many ways: polynomial backtracking, CodeQL
 * js/polynomial-redos). Matched only after the `PAYER_EMAIL_MAX_LENGTH` cap, RFC 5321's limit.
 */
const PAYER_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const PAYER_EMAIL_MAX_LENGTH = 254;
/**
 * A Lydia `request_uuid`, the id of a checkout session: 32 hex digits with NO dashes, as
 * `request/do` answers it (measured on the sandbox 2026-10-15, payments.md). It used to be the
 * dashed RFC 4122 shape, which no Lydia request ever has, so `request-state` refused every real
 * request as "Invalid payload".
 */
export const SESSION_ID_RE = /^[0-9a-f]{32}$/i;

/**
 * The `code` of the 409 refusing an onboarding while a Business is already linked. Mirrored by
 * social-service's link route and the frontend's `lydiaOnboardingRefusal.ts`.
 */
export const LYDIA_ACCOUNT_ALREADY_LINKED = 'LYDIA_ACCOUNT_ALREADY_LINKED';

/**
 * The `code` of the 503 answered when the payout account cannot be read before `business/create`:
 * an unknown state is never read as "not linked", which would let a second Business be created.
 */
export const PAYOUT_ACCOUNT_UNREADABLE = 'PAYOUT_ACCOUNT_UNREADABLE';

function payoutAccountUnreadable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: PAYOUT_ACCOUNT_UNREADABLE,
    message: 'The payout account could not be read; nothing was created',
  });
}

/**
 * The `code` of the 409 refusing an onboarding while another `business/create`'s outcome is not
 * known (social-service's `associations."lydiaEnrolmentStartedAt"`, migration 118).
 */
export const LYDIA_ENROLMENT_IN_FLIGHT = 'LYDIA_ENROLMENT_IN_FLIGHT';

/** social-service's `code` (409) of a cashier operation while another one is in flight (lot 3). */
export const LYDIA_CASHIER_IN_FLIGHT = 'LYDIA_CASHIER_IN_FLIGHT';

/** The `code` (409) of a Responsable asked for an association with no Business linked. */
export const LYDIA_NO_BUSINESS = 'LYDIA_NO_BUSINESS';
/** The `code` (400) of a Responsable who is not a member of the association. */
export const LYDIA_RESPONSABLE_NOT_A_MEMBER = 'LYDIA_RESPONSABLE_NOT_A_MEMBER';
/** The `code` (409) of a "record" whose phone Lydia does not list as a cashier managing cashiers. */
export const LYDIA_RESPONSABLE_NOT_A_CASHIER = 'LYDIA_RESPONSABLE_NOT_A_CASHIER';
/** The `code` (409) of a second person asked as Responsable: changing them is lot 3. */
export const LYDIA_RESPONSABLE_ALREADY_SET = 'LYDIA_RESPONSABLE_ALREADY_SET';
/**
 * The `code` (409) of a THIRD number for the live Responsable while another one is still tracked on
 * the row (an old number whose removal Lydia has not confirmed, or a new one it did not confirm -
 * lot 3), or of another number in record mode. Also social-service's.
 */
export const LYDIA_RESPONSABLE_PHONE_LOCKED = 'LYDIA_RESPONSABLE_PHONE_LOCKED';
/**
 * The `code` (409) of a Responsable number change while it is switched off: it follows
 * `LYDIA_CASHIER_ADD_ENABLED` (the owner's decision), and nothing reaches Lydia.
 */
export const LYDIA_RESPONSABLE_NUMBER_CHANGE_DISABLED = 'LYDIA_RESPONSABLE_NUMBER_CHANGE_DISABLED';
/**
 * The `code` (403) of a Responsable number change asked by someone who is neither that
 * Responsable nor a global admin: managing the payout account alone does not allow it.
 */
export const LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN =
  'LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN';
/**
 * social-service's `code` (409) when the association's Business changed between the claim and the
 * store: the unlink closed its cashier rows, and the store released the claim.
 */
export const LYDIA_BUSINESS_CHANGED = 'LYDIA_BUSINESS_CHANGED';

function alreadyLinked(): ConflictException {
  return new ConflictException({
    code: LYDIA_ACCOUNT_ALREADY_LINKED,
    message: 'A Lydia Business is already linked to this association',
  });
}

/** Controller handling Lydia Business onboarding and checkout sessions. */
@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  private async assertCanManageAssociation(
    req: Request,
    associationId: string,
    /** A bound on social-service's answer; the onboarding passes its step budget, others none. */
    timeoutMs?: number
  ): Promise<void> {
    await assertCanManageAssociation(req, associationId, this.logger, timeoutMs);
  }

  /**
   * Returns which payment provider is active, so the frontend can render the matching onboarding
   * flow. Deliberately carries NO guard: the value is global platform config (`'lydia' |
   * 'disabled'`), never user-specific or sensitive, and `AssociationsService`/`ProductsService` in
   * social-service call it directly over the Docker network (`http://core-service:3012/...`) to
   * resolve `resolvePaymentTarget` - a path that never goes through nginx and so can never carry an
   * `X-User-Id`. `NginxAuthGuard` here rejected every one of those calls with 401 `Missing
   * X-User-Id header` (observed in production, 2026-09-14), taking down `resolvePaymentTarget` -
   * the resolver EVERY payment path in social-service depends on - even though nothing about this
   * route needed a caller's identity in the first place.
   */
  @Get('provider')
  async getActiveProvider() {
    return { provider: await this.paymentService.getActiveProviderId() };
  }

  /** Starts or resumes a Connect-style onboarding flow for an association and returns the onboarding URL. */
  @UseGuards(NginxAuthGuard)
  @Post('onboarding')
  @HttpCode(200)
  async createOnboarding(
    @Body()
    body: {
      associationId: string;
      existingAccountId?: string;
      returnUrl?: string;
      refreshUrl?: string;
      /** Required by Lydia's business/create. */
      legalProfile?: {
        name: string;
        address: string;
        zipcode: string;
        city: string;
        country: string;
        businessEmail: string;
        businessPhone: string;
      };
    },
    @Req() req: Request
  ) {
    if (!(await this.paymentService.isConfigured())) {
      return { ok: false, message: 'Payment provider not configured' };
    }

    // THE CHECK IS NOT CONDITIONAL ON THE FIELD BEING SENT. It used to sit inside `if (assocId)`,
    // so a body that simply omitted `associationId` reached the provider with no authorization at
    // all - an authorization check a caller skips by leaving a field out is not a check.
    const assocId = body.associationId?.trim();
    if (!assocId) {
      throw new BadRequestException('associationId is required');
    }
    if (!UUID_RE.test(assocId)) {
      throw new BadRequestException('Invalid associationId');
    }
    // Every step below has its own bound, summing under nginx's timeout, so a slow call ends as a
    // TYPED answer from here rather than a bare 504 from nginx (LYDIA_ONBOARDING_STEP_TIMEOUT_MS).
    await this.assertCanManageAssociation(
      req,
      assocId,
      LYDIA_ONBOARDING_STEP_TIMEOUT_MS.permission
    );
    await this.assertNoLinkedBusiness(assocId);

    const legalProfile = body.legalProfile
      ? {
          name: String(body.legalProfile.name ?? '').trim(),
          address: String(body.legalProfile.address ?? '').trim(),
          zipcode: String(body.legalProfile.zipcode ?? '').trim(),
          city: String(body.legalProfile.city ?? '').trim(),
          country: String(body.legalProfile.country ?? '').trim(),
          businessEmail: String(body.legalProfile.businessEmail ?? '').trim(),
          businessPhone: String(body.legalProfile.businessPhone ?? '').trim(),
        }
      : undefined;

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost').replace(/\/$/, '');
    const returnUrl = body.returnUrl?.trim() || `${frontendUrl}/associations`;
    const refreshUrl = body.refreshUrl?.trim() || returnUrl;
    let result;
    try {
      result = await this.paymentService.createConnectOnboarding({
        associationId: body.associationId ?? '',
        existingAccountId: body.existingAccountId,
        refreshUrl,
        returnUrl,
        legalProfile,
        onBusinessCreated: (vendorToken) => this.recordPendingEnrolmentToken(assocId, vendorToken),
      });
    } catch (err: unknown) {
      // A REFUSAL (a 400: Lydia's typed refusal, an incomplete profile) created nothing, so the
      // marker claimed above is released and a corrected retry may run. An unconfirmed (504) or
      // orphan (502) outcome leaves it set: a second Business must not be created on a guess.
      if (err instanceof BadRequestException) await this.releaseEnrolmentMarker(assocId, 'refused');
      throw err;
    }

    // Persist the Business on the association (social-service): its `vendor_token`, its
    // dashboard_url and its private token are each handed out exactly once, at business/create, so
    // they are captured here or gone for good. A failure here FAILS the onboarding: answering a
    // success with nothing linked would invite a second business/create.
    try {
      await axios.post(
        socialUrl(`associations/${assocId}/lydia-account`),
        {
          lydiaAccountId: result.accountId,
          lydiaDashboardUrl: result.url || undefined,
          businessPrivateToken: result.businessPrivateToken,
        },
        { ...internalSocialRequestConfig(), timeout: LYDIA_ONBOARDING_STEP_TIMEOUT_MS.link }
      );
    } catch (err: unknown) {
      const error = err as Error & { response?: { status?: number; data?: unknown } };
      this.logger.error(
        `Lydia onboarding of association ${assocId}: the link to social-service failed`,
        describeHttpError(error)
      );
      // Classified on the CODE social-service answered, never on the status alone.
      const code = (error.response?.data as { code?: unknown } | undefined)?.code;
      const concurrent = code === LYDIA_ACCOUNT_ALREADY_LINKED;
      // Either way this Business is an orphan: its ERROR line is the record an admin works from.
      const orphan = businessCreatedUnlinked(
        this.logger,
        assocId,
        result.accountId,
        concurrent
          ? 'another onboarding linked a Business first'
          : `the link failed (${error.response?.status ?? 'no answer'})`
      );
      // A concurrent run linked one: the screen shows that Business, so it gets the 409.
      throw concurrent ? alreadyLinked() : orphan;
    }
    this.logger.log(`Lydia onboarding of association ${assocId}: Business linked with its key`);

    // The private token stays server-side: the browser gets the public pair only.
    return { url: result.url, accountId: result.accountId };
  }

  /**
   * CLAIMS THE ENROLMENT before `business/create` (lot 2): social-service sets the durable
   * "enrolment in flight" marker in ONE statement, only where none is set and no Business is linked
   * (`AssociationsService.claimLydiaEnrolment`). So a Business already linked is the typed 409
   * `LYDIA_ACCOUNT_ALREADY_LINKED` (`business/create` would replace it silently, lydia-api.md
   * section 2), and an earlier create whose outcome is unknown is the typed 409
   * `LYDIA_ENROLMENT_IN_FLIGHT` until a global admin clears it - a second Business is REFUSED, not
   * merely discouraged. An unread state is never read as "free": 503 `PAYOUT_ACCOUNT_UNREADABLE`.
   */
  private async assertNoLinkedBusiness(associationId: string): Promise<void> {
    let res;
    try {
      res = await axios.post<{ code?: unknown }>(
        socialUrl(
          `internal/associations/${encodeURIComponent(associationId)}/lydia-enrolment-claim`
        ),
        {},
        {
          ...internalSocialRequestConfig(),
          validateStatus: () => true,
          timeout: LYDIA_ONBOARDING_STEP_TIMEOUT_MS.payoutRead,
        }
      );
    } catch (err: unknown) {
      this.logger.error(
        `Lydia onboarding of association ${associationId}: the enrolment could not be claimed`,
        describeHttpError(err as Error)
      );
      throw payoutAccountUnreadable();
    }
    if (res.status === 404) {
      // No such association: nothing to link to, so business/create is never called.
      this.logger.warn(`Lydia onboarding refused: association ${associationId} not found`);
      throw new NotFoundException('Association not found');
    }
    const code = res.data && typeof res.data === 'object' ? res.data.code : undefined;
    if (res.status === 409 && code === LYDIA_ACCOUNT_ALREADY_LINKED) {
      this.logger.warn(
        `Lydia onboarding of association ${associationId} refused: a Business is already linked`
      );
      throw alreadyLinked();
    }
    if (res.status === 409 && code === LYDIA_ENROLMENT_IN_FLIGHT) {
      this.logger.warn(
        `Lydia onboarding of association ${associationId} refused: an enrolment is in flight`
      );
      throw new ConflictException({
        code: LYDIA_ENROLMENT_IN_FLIGHT,
        message: 'An enrolment of this association is in flight; its outcome must be checked first',
      });
    }
    if (res.status >= 400) {
      // NOT "free": an unread state never lets a second Business be created.
      this.logger.error(
        `Lydia onboarding of association ${associationId}: the enrolment claim answered HTTP ${res.status}`
      );
      throw payoutAccountUnreadable();
    }
  }

  /**
   * Records the vendor token `business/create` just answered on the association, before its key
   * check and link, so a `BUSINESS_VALIDATED` racing the link is answered 503 (retry) rather than
   * dropped. A failure is an ERROR and the enrolment goes on: the link step still decides.
   */
  private async recordPendingEnrolmentToken(associationId: string, vendorToken: string) {
    try {
      await axios.post(
        socialUrl(
          `internal/associations/${encodeURIComponent(associationId)}/lydia-enrolment-vendor-token`
        ),
        { vendorToken },
        { ...internalSocialRequestConfig(), timeout: LYDIA_ONBOARDING_STEP_TIMEOUT_MS.payoutRead }
      );
      this.logger.debug(`Lydia onboarding of association ${associationId}: pending token recorded`);
    } catch (err: unknown) {
      this.logger.error(
        `Lydia onboarding of association ${associationId}: the pending Business token could not ` +
          `be recorded - a validation arriving before the link will not be retried ` +
          `(${describeHttpError(err)})`
      );
    }
  }

  /** Releases the enrolment marker (a typed refusal, or a global admin); failures are logged. */
  private async releaseEnrolmentMarker(associationId: string, why: 'refused' | 'admin') {
    try {
      await axios.post(
        socialUrl(
          `internal/associations/${encodeURIComponent(associationId)}/lydia-enrolment-release`
        ),
        { why },
        { ...internalSocialRequestConfig(), timeout: LYDIA_ONBOARDING_STEP_TIMEOUT_MS.payoutRead }
      );
    } catch (err: unknown) {
      this.logger.error(
        `Lydia onboarding of association ${associationId}: the enrolment marker could not be ` +
          `released (${why}) - a retry is refused until a global admin clears it`,
        describeHttpError(err as Error)
      );
      if (why === 'admin') throw new ServiceUnavailableException('The marker could not be cleared');
    }
  }

  /**
   * Releases the Responsable step's claim after an outcome core-service KNOWS; a failure is logged
   * at ERROR (the claim then waits for a global admin) and never replaces the answer being given.
   */
  private async releaseResponsableClaim(associationId: string, claimToken: string): Promise<void> {
    try {
      await axios.post(
        socialUrl(
          `internal/associations/${encodeURIComponent(associationId)}/lydia-responsable-release`
        ),
        { claimToken },
        { ...internalSocialRequestConfig(), timeout: LYDIA_ONBOARDING_STEP_TIMEOUT_MS.payoutRead }
      );
    } catch (err: unknown) {
      this.logger.error(
        `Lydia Responsable of ${associationId}: the step's claim could not be released - a global ` +
          `admin clears it`,
        describeHttpError(err as Error)
      );
    }
  }

  /**
   * Clears the "enrolment in flight" marker (GLOBAL ADMIN only), after the admin checked with
   * Lydia's support that the unconfirmed `business/create` left no Business behind (or had it
   * deleted). The association may then enrol again. It clears the Responsable step's claim too.
   */
  @Post('lydia-enrolment-clear/:associationId')
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @HttpCode(200)
  async clearEnrolmentInFlight(@Param('associationId') associationId: string) {
    if (!UUID_RE.test(associationId)) {
      throw new BadRequestException('Invalid associationId');
    }
    this.logger.log(`Lydia enrolment marker cleared by a global admin on ${associationId}`);
    await this.releaseEnrolmentMarker(associationId, 'admin');
    return { ok: true };
  }

  /**
   * Adds (or records) the Responsable of an association's Lydia Business - enrolment step 2
   * (MANAGE_PAYOUT_ACCOUNT holders). Body `{ userId, phone, mode }`: `phone` E.164 (`+33...`),
   * never logged; `mode: 'add'` asks Lydia to add the person with every right and its SMS
   * (`addLydiaBusinessHolder`, the same call re-sends the SMS); `mode: 'record'` is for a Business
   * linked before lot 2: a READ of the person's rights at Lydia, recorded only when they already
   * manage cashiers (`access_cashier`), with no SMS and no change at Lydia.
   *
   * The person must be a member of the association; another person as Responsable is refused
   * (typed refusals, `LYDIA_*` codes in `libs/contracts/lydia-refusal-codes.json`). Lydia's
   * read-back confirming, social-service stores the row, the phone sealed; once
   * `business/addcashier` has answered, any later failure stores it UNCONFIRMED (Lydia holds that
   * number) and the same-number resend confirms it.
   *
   * ANOTHER NUMBER for the live Responsable is a NUMBER CHANGE (lot 3): switched off with
   * `LYDIA_CASHIER_ADD_ENABLED` (409 `LYDIA_RESPONSABLE_NUMBER_CHANGE_DISABLED`), and allowed only
   * to that Responsable or a global admin (403 `LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN`) - both
   * refused before Lydia is asked anything. The new number is added; only once Lydia CONFIRMS it
   * with every right does it become the live one, and only then is the number it replaced removed
   * (`LydiaCashierOps.revoke`, `previous`, with its own control read and re-read). Unconfirmed, the
   * old number stays the live one with every right. Switching back to the other number tracked on
   * the row is the same path.
   */
  @Post('lydia-responsable/:associationId')
  @UseGuards(NginxAuthGuard)
  @HttpCode(200)
  async setLydiaResponsable(
    @Param('associationId') associationId: string,
    @Body() body: { userId?: unknown; phone?: unknown; mode?: unknown },
    @Req() req: Request
  ) {
    if (!UUID_RE.test(associationId)) {
      throw new BadRequestException('Invalid associationId');
    }
    await this.assertCanManageAssociation(req, associationId);
    const actorId = (req.headers['x-user-id'] as string | undefined)?.trim() ?? '';
    const globalAdmin = req.headers['x-global-admin'] === 'true';
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    const phone = typeof body?.phone === 'string' ? body.phone.trim() : '';
    const mode = body?.mode === 'record' ? 'record' : body?.mode === 'add' ? 'add' : null;
    if (!userId || !mode) {
      throw new BadRequestException('userId and mode (add | record) are required');
    }
    if (!LYDIA_CASHIER_PHONE_RE.test(phone)) {
      this.logger.warn(`Lydia Responsable of ${associationId} refused: the phone is not E.164`);
      throw new BadRequestException({
        code: LYDIA_CASHIER_PHONE_INVALID,
        message: 'The phone number must be written +33...',
      });
    }
    // The checks AND the claim of this step, in social-service, in one locked transaction: claimed
    // only when every check passes, so two operations cannot both have Lydia change a cashier
    // (typed 409 `LYDIA_RESPONSABLE_IN_FLIGHT`, passed on as given).
    const pre = await this.responsableSocialStep(associationId, 'claim', () =>
      axios.post<{
        vendorToken: string | null;
        member: boolean;
        currentUserId: string | null;
        phoneMatches: boolean;
        numberChange?: boolean;
        claimed: boolean;
        claimToken?: string | null;
      }>(
        socialUrl(
          `internal/associations/${encodeURIComponent(associationId)}/lydia-responsable-claim`
        ),
        { userId, phone, mode, allowNumberChange: true },
        { ...internalSocialRequestConfig(), timeout: 10_000 }
      )
    );
    if (!pre?.vendorToken) {
      throw new ConflictException({
        code: LYDIA_NO_BUSINESS,
        message: 'No Lydia Business is linked to this association',
      });
    }
    if (!pre.member) {
      this.logger.warn(`Lydia Responsable of ${associationId} refused: not a member`);
      throw new BadRequestException({
        code: LYDIA_RESPONSABLE_NOT_A_MEMBER,
        message: 'The Responsable must be a member of the association',
      });
    }
    if (pre.currentUserId && pre.currentUserId !== userId) {
      this.logger.warn(`Lydia Responsable of ${associationId} refused: another one is set`);
      throw new ConflictException({
        code: LYDIA_RESPONSABLE_ALREADY_SET,
        message: 'This association already has a Responsable',
      });
    }
    if (!pre.phoneMatches && pre.numberChange !== true) {
      // The same person with a THIRD number while another one is tracked (or in record mode):
      // refused BEFORE any call.
      this.logger.warn(
        `Lydia Responsable of ${associationId} refused: another number while it is locked`
      );
      throw new ConflictException({
        code: LYDIA_RESPONSABLE_PHONE_LOCKED,
        message: 'Another number of the Responsable is still being changed',
      });
    }
    if (!pre.claimed || !pre.claimToken) {
      // Every check passed, so social-service claimed or refused: an answer with neither is not one.
      this.logger.error(`Lydia Responsable of ${associationId}: the claim answered unclaimed`);
      throw new ServiceUnavailableException('The association service answered unexpectedly');
    }
    const claimToken = pre.claimToken;
    if (pre.numberChange === true) {
      await this.assertNumberChangeAllowed(associationId, claimToken, {
        actorId,
        userId,
        globalAdmin,
      });
    }
    try {
      if (mode === 'add') {
        await this.paymentService.addLydiaBusinessHolder(associationId, pre.vendorToken, phone);
      } else {
        const rights = await this.paymentService.readLydiaCashierRights(
          associationId,
          pre.vendorToken,
          phone
        );
        if (!rights.access_cashier) {
          this.logger.warn(
            `Lydia Responsable of ${associationId} not recorded: that number does not manage cashiers at Lydia`
          );
          throw new ConflictException({
            code: LYDIA_RESPONSABLE_NOT_A_CASHIER,
            message: 'That number is not a cashier managing cashiers of this Business at Lydia',
          });
        }
      }
    } catch (err: unknown) {
      if (err instanceof LydiaCashierAddedUnconfirmedException) {
        // Lydia answered the add: it holds that number now, so it is recorded UNCONFIRMED - for a
        // number change only TRACKED, the old number staying the live one - and the record
        // releases the claim. If even that store fails, the claim stays for a global admin.
        await this.recordUnconfirmedResponsable(associationId, pre.vendorToken, {
          userId,
          phone,
          actorId,
          claimToken,
        });
        throw err;
      }
      // A KNOWN outcome releases the claim: a read changes nothing at Lydia, and a typed refusal
      // added nothing. No usable answer to an ADD (`LYDIA_UNREACHABLE`, or an untyped failure)
      // keeps it until a global admin clears it (`lydia-enrolment-clear`).
      const answer = err instanceof HttpException ? err.getResponse() : undefined;
      const typedCode =
        answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
      const known =
        mode === 'record' || (err instanceof HttpException && typedCode !== LYDIA_UNREACHABLE);
      if (known) {
        await this.releaseResponsableClaim(associationId, claimToken);
      } else {
        this.logger.error(
          `Lydia Responsable of ${associationId}: the add's outcome is unknown - the step stays ` +
            `claimed until a global admin clears it`
        );
      }
      throw err;
    }
    // Lydia has the number now; a failure to STORE is said at ERROR and keeps the claim, so a
    // global admin clears it once checked (the add replaces the rights, so a later add is safe).
    const data = await this.responsableSocialStep(associationId, 'store', () =>
      axios.post<{ responsable: unknown; cashierId?: string | null; removeOther?: boolean }>(
        socialUrl(`internal/associations/${encodeURIComponent(associationId)}/lydia-responsable`),
        {
          vendorToken: pre.vendorToken,
          userId,
          phone,
          addedByUserId: actorId,
          confirmed: true,
          claimToken,
        },
        { ...internalSocialRequestConfig(), timeout: 10_000 }
      )
    );
    this.logger.log(
      `Lydia Responsable of ${associationId} ${mode === 'add' ? 'added' : 'recorded'}`
    );
    if (data?.removeOther === true && data.cashierId) {
      // Lot 3: the new number is CONFIRMED with every right; only now does the number it replaced
      // go. A removal Lydia does not confirm answers the typed 502; the row keeps that number,
      // flagged, for a later removal.
      await this.removeReplacedResponsableNumber(associationId, data.cashierId, actorId);
    }
    return { ok: true, responsable: data?.responsable ?? null };
  }

  /**
   * The gate and the identity rule of a Responsable NUMBER CHANGE (the owner's decision, lot 3),
   * checked once the step is claimed and before Lydia is asked anything; a refusal releases the
   * claim. Off while `LYDIA_CASHIER_ADD_ENABLED` is off (409
   * `LYDIA_RESPONSABLE_NUMBER_CHANGE_DISABLED`); on, only the Responsable themselves or a global
   * admin may (403 `LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN`).
   */
  private async assertNumberChangeAllowed(
    associationId: string,
    claimToken: string,
    who: { actorId: string; userId: string; globalAdmin: boolean }
  ): Promise<void> {
    if (!this.numberChangeEnabled()) {
      this.logger.warn(
        `Lydia Responsable of ${associationId}: number change refused - switched off`
      );
      await this.releaseResponsableClaim(associationId, claimToken);
      throw new ConflictException({
        code: LYDIA_RESPONSABLE_NUMBER_CHANGE_DISABLED,
        message: "Changing the Responsable's number is not open yet",
      });
    }
    if (who.actorId !== who.userId && !who.globalAdmin) {
      this.logger.warn(
        `Lydia Responsable of ${associationId}: number change refused - asked by someone other ` +
          `than the Responsable or a global admin`
      );
      await this.releaseResponsableClaim(associationId, claimToken);
      throw new ForbiddenException({
        code: LYDIA_RESPONSABLE_NUMBER_CHANGE_FORBIDDEN,
        message: 'Only the Responsable or a platform administrator may change this number',
      });
    }
    this.logger.log(`Lydia Responsable of ${associationId}: number change allowed`);
  }

  /** The owner's gate on a Responsable number change, read through a method so a spec can open it. */
  numberChangeEnabled(): boolean {
    return LYDIA_CASHIER_ADD_ENABLED;
  }

  /**
   * Removes the number a CONFIRMED number change replaced (`LydiaCashierOps.revoke`, `previous`).
   * Another cashier operation holding the claim is not a failure of THIS request: that number stays
   * listed for removal (WARN). Every other outcome is passed on.
   */
  private async removeReplacedResponsableNumber(
    associationId: string,
    cashierId: string,
    actorId: string
  ): Promise<void> {
    try {
      await new LydiaCashierOps(this.paymentService).revoke(
        associationId,
        cashierId,
        'previous',
        actorId
      );
    } catch (err: unknown) {
      const answer = err instanceof HttpException ? err.getResponse() : undefined;
      const code =
        answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
      if (code === LYDIA_CASHIER_IN_FLIGHT) {
        this.logger.warn(
          `Lydia Responsable of ${associationId}: the replaced number's removal waits - another ` +
            `cashier operation is in flight`
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Stores a Responsable number Lydia added but did not confirm (`confirmed: false`) under the
   * step's claim, so it is guarded; social-service's record releases the claim. Logged at ERROR
   * either way (association and the phone's last two digits only): stored, a removal may be owed
   * unless the same-number resend confirms it; not stored, the claim stays for an admin.
   */
  private async recordUnconfirmedResponsable(
    associationId: string,
    vendorToken: string,
    who: { userId: string; phone: string; actorId: string; claimToken: string }
  ): Promise<void> {
    const phoneEnd = who.phone.slice(-2);
    try {
      await this.responsableSocialStep(associationId, 'store', () =>
        axios.post<{ responsable: unknown }>(
          socialUrl(`internal/associations/${encodeURIComponent(associationId)}/lydia-responsable`),
          {
            vendorToken,
            userId: who.userId,
            phone: who.phone,
            addedByUserId: who.actorId,
            confirmed: false,
            claimToken: who.claimToken,
          },
          { ...internalSocialRequestConfig(), timeout: 10_000 }
        )
      );
      this.logger.error(
        `Lydia Responsable of ${associationId} (phone ending ${phoneEnd}) added at Lydia, ` +
          `UNCONFIRMED - recorded; the same-number resend confirms it`
      );
    } catch (err) {
      // A 409 is social-service's typed refusal of the store, and its record releases the claim on
      // every conflict: saying "stays claimed" there would be false.
      if (err instanceof HttpException && err.getStatus() === 409) {
        const answer = err.getResponse();
        const code =
          answer && typeof answer === 'object' ? (answer as { code?: unknown }).code : undefined;
        this.logger.error(
          `Lydia Responsable of ${associationId} (phone ending ${phoneEnd}) added at Lydia, ` +
            `UNCONFIRMED and NOT recorded: the store refused it (${String(code)}); claim released ` +
            `by the store` +
            (code === LYDIA_BUSINESS_CHANGED ? '; the unlink closed the rows' : '')
        );
        return;
      }
      this.logger.error(
        `Lydia Responsable of ${associationId} (phone ending ${phoneEnd}) added at Lydia, ` +
          `UNCONFIRMED and NOT recorded - the step stays claimed until a global admin clears it`
      );
    }
  }

  /**
   * One social-service call of the Responsable route. A 4xx is social-service's ANSWER (a member
   * check, the live Responsable, a Business changed meanwhile) and is passed on as it was given,
   * typed code included; a 5xx or no answer is a 503 logged at ERROR, never a bare 500.
   */
  private async responsableSocialStep<T>(
    associationId: string,
    step: 'claim' | 'store',
    call: () => Promise<{ data: T }>
  ): Promise<T> {
    try {
      return (await call()).data;
    } catch (err: unknown) {
      const answer = (err as { response?: { status?: unknown; data?: unknown } }).response;
      if (typeof answer?.status === 'number' && answer.status >= 400 && answer.status < 500) {
        this.logger.warn(
          `Lydia Responsable of ${associationId}: social-service refused the ${step} (${answer.status})`
        );
        throw new HttpException(answer.data as Record<string, unknown>, answer.status);
      }
      this.logger.error(
        `Lydia Responsable of ${associationId}: the ${step} at social-service failed` +
          (step === 'store'
            ? ' AFTER Lydia added the cashier - the step stays claimed until a global admin clears it'
            : ''),
        describeHttpError(err as Error)
      );
      throw new ServiceUnavailableException('The association service could not be reached');
    }
  }

  /**
   * Unlinks an association's Lydia Business from Canari (MANAGE_PAYOUT_ACCOUNT).
   * Local unlink only - the Lydia Business itself is untouched and onboarding can be restarted.
   */
  @Post('disconnect-lydia-account/:associationId')
  @HttpCode(200)
  async disconnectLydiaAccount(@Param('associationId') associationId: string, @Req() req: Request) {
    if (!UUID_RE.test(associationId)) {
      throw new BadRequestException('Invalid associationId');
    }
    await this.assertCanManageAssociation(req, associationId);

    try {
      await axios.post(
        socialUrl(`associations/${encodeURIComponent(associationId)}/lydia-disconnect`),
        undefined,
        internalSocialRequestConfig()
      );
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error('Failed to disconnect Lydia account', describeHttpError(error));
      throw new BadRequestException('Could not disconnect the Lydia account');
    }

    return { ok: true };
  }

  /**
   * Validates a Lydia onboarding BY HAND (global admin only) - the backup of Lydia's unsigned
   * `BUSINESS_VALIDATED` webhook, through the SAME social-service path (`markLydiaReady`, cause
   * `admin`). A platform admin who has seen Lydia accept the club's file says so here. It is NOT open to the club's own managers - they
   * would be declaring their own account ready, and releasing withheld products onto it - and it
   * needs a linked Lydia account, so it cannot validate an onboarding that never started.
   */
  @Post('complete-lydia-account/:associationId')
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @HttpCode(200)
  async completeLydiaAccount(@Param('associationId') associationId: string) {
    if (!UUID_RE.test(associationId)) {
      throw new BadRequestException('Invalid associationId');
    }
    this.logger.log(`Lydia onboarding validated by hand for association ${associationId}`);

    const assoRes = await axios.get<{ lydiaAccountId?: string | null }>(
      internalPaymentAccountUrl(associationId),
      { ...internalSocialRequestConfig(), validateStatus: () => true }
    );
    if (assoRes.status >= 400) {
      throw new BadRequestException('Association not found');
    }
    if (!assoRes.data.lydiaAccountId?.trim()) {
      throw new BadRequestException('No Lydia account is linked to this association');
    }

    try {
      await axios.post(
        socialUrl(`associations/${encodeURIComponent(associationId)}/lydia-complete`),
        undefined,
        internalSocialRequestConfig()
      );
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error('Failed to validate the Lydia onboarding', describeHttpError(error));
      throw new BadRequestException('Could not validate the Lydia onboarding');
    }

    return { ok: true };
  }

  /**
   * Creates a checkout session for the given line items and returns its URL.
   *
   * SERVER-TO-SERVER ONLY: social-service calls it (paid form, product) straight at this service, past
   * nginx, so there is no `X-User-Id` for `NginxAuthGuard` to read - it answered 401 `Missing X-User-Id
   * header` to every call, on dev 2026-10-07. The shared internal secret is what that caller carries.
   */
  @Post('create-checkout-session')
  @HttpCode(200)
  async createCheckout(
    @Body()
    body: {
      lineItems: WireLineItem[];
      successUrl: string;
      cancelUrl: string;
      metadata?: Record<string, string>;
      connectAccountId?: string;
      /** Stable key for idempotency, carried to Lydia's request/do as its order_ref. */
      idempotencyKey?: string;
      /** The payer's address, which Lydia's request/do needs as its recipient. Never stored. */
      payerEmail?: string;
      /** How long the request stays payable, in whole seconds: the caller's seat hold. */
      expireAfterSeconds?: number;
    },
    @Headers('x-internal-secret') secret?: string
  ) {
    assertInternalSecret(secret);
    if (!body || !body.lineItems || !Array.isArray(body.lineItems)) {
      throw new BadRequestException('Invalid payload');
    }
    if (
      body.expireAfterSeconds !== undefined &&
      (!Number.isInteger(body.expireAfterSeconds) || body.expireAfterSeconds <= 0)
    ) {
      throw new BadRequestException('Invalid expireAfterSeconds');
    }

    if (!(await this.paymentService.isConfigured())) {
      return { ok: false, message: 'Payment provider not configured' };
    }

    const payerEmail = body.payerEmail?.trim();
    if (
      payerEmail &&
      (payerEmail.length > PAYER_EMAIL_MAX_LENGTH || !PAYER_EMAIL_RE.test(payerEmail))
    ) {
      throw new BadRequestException('Invalid payerEmail');
    }

    try {
      const session = await this.paymentService.createCheckoutSession({
        payerRecipient: payerEmail ? { value: payerEmail, type: 'email' } : undefined,
        lineItems: body.lineItems,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        metadata: body.metadata,
        connectAccountId: body.connectAccountId,
        idempotencyKey: body.idempotencyKey,
        expireAfterSeconds: body.expireAfterSeconds,
      });
      this.logger.debug(
        `[Payments] Checkout session created: ${session.id} (request ${session.requestId ?? 'none'})`
      );
      return { ok: true, url: session.url, id: session.id, requestId: session.requestId };
    } catch (err: unknown) {
      // A typed refusal (the Lydia provider's PAYMENT_PROVIDER_REFUSED) is already the answer:
      // re-labelling it would bury both its code and its readable message.
      if (err instanceof HttpException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Payments] create-checkout-session failed: ${msg}`);
      throw new BadRequestException(`Payment error: ${msg}`);
    }
  }

  /**
   * The two routes social-service reads a request's FATE from (`request-state`, `cancel-request`):
   * a 400 from them must mean "Lydia refused THIS request" and nothing else, because the
   * reconciliation sweep acts on it. So the only 400 that leaves is Lydia's typed refusal
   * (`PAYMENT_PROVIDER_REFUSED`, with its `providerCode`). Every other 400 is a state of CORE -
   * payments switched off by an admin (an in-flight payment must stay readable), Lydia not
   * configured, a payload this route will not read - and answers 503
   * (`PAYMENT_SERVICE_NOT_READY`): the caller retries, it never closes a row on it.
   */
  private async aboutTheRequest<T>(route: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err: unknown) {
      if (!(err instanceof BadRequestException)) throw err;
      const body = err.getResponse();
      if (
        body &&
        typeof body === 'object' &&
        (body as { code?: unknown }).code === PAYMENT_PROVIDER_REFUSED
      ) {
        throw err;
      }
      this.logger.warn(
        `${route}: ${err.message} - answered 503, a state of core and not a word about the request`
      );
      throw new ServiceUnavailableException({
        code: 'PAYMENT_SERVICE_NOT_READY',
        message: err.message,
      });
    }
  }

  /**
   * Makes a payment request no longer payable at the provider. SERVER-TO-SERVER ONLY, like
   * `create-checkout-session`: social-service calls it when a retry replaces the request a pending
   * answer was waiting on, BEFORE issuing the new one. `requestId` is the provider's own id (Lydia's
   * numeric `request_id`) and `connectAccountId` the Business that request was issued to.
   * Answers `{ ok: true, outcome }`. `already-settled` (Lydia's error 2) means PROCESSED - cancelled,
   * expired, or very probably PAID - so the caller reads `request-state` before treating the
   * request as dead. A refusal is the provider's typed 400.
   */
  @Post('cancel-request')
  @HttpCode(200)
  async cancelRequest(
    @Body() body: { requestId?: string; connectAccountId?: string },
    @Headers('x-internal-secret') secret?: string
  ) {
    assertInternalSecret(secret);
    return this.aboutTheRequest('cancel-request', () => this.cancelNamedRequest(body));
  }

  /** `cancel-request` past its secret check: see `aboutTheRequest` for what a 400 still means. */
  private async cancelNamedRequest(body: { requestId?: string; connectAccountId?: string }) {
    if (
      typeof body?.requestId !== 'string' ||
      !/^\d{1,32}$/.test(body.requestId) ||
      typeof body.connectAccountId !== 'string' ||
      !body.connectAccountId.trim()
    ) {
      throw new BadRequestException('Invalid payload');
    }
    const outcome = await this.paymentService.cancelCheckoutRequest(
      body.requestId,
      body.connectAccountId
    );
    return { ok: true, outcome };
  }

  /**
   * Reads a payment request's state at the provider. SERVER-TO-SERVER ONLY (internal secret):
   * social-service asks it when a cancel answered `already-settled`, to tell a request that was
   * PAID (the answer is then paid, and no new request may be issued) from one cancelled or expired.
   * `sessionId` is the `request_uuid`; answers `{ ok: true, state, raw }`, `state` the TYPED
   * `CheckoutRequestStateKind` (open | paid | declined | cancelled-or-expired | unknown) the
   * provider classified - the caller decides on it and never on `raw`, which is for its log.
   *
   * `orderRef` INSTEAD of `sessionId` reads a boutique attempt whose issuing call never answered a
   * uuid (a timeout, a crash mid-issue) by the order_ref Canari sent it with - only Canari's own
   * product grammar (`parseLydiaOrderRef`), never a free string - and may answer `not-found`: no
   * request carries it. Exactly one of the two is accepted.
   *
   * `expectedAmountCents` (a whole number of cents) asks for the answer to be VERIFIED: the
   * signature Lydia returns is checked with the Business key over that amount and the id read
   * (`PaymentService.getVerifiedCheckoutRequestState`), and the answer carries `verification`
   * (`verified | mismatch | unsigned | no-key`; with `no-key`, no state - Lydia was not asked).
   * The signature itself is never returned. Without it the route answers as before, unverified.
   */
  @Post('request-state')
  @HttpCode(200)
  async requestState(
    @Body()
    body: {
      sessionId?: string;
      orderRef?: string;
      connectAccountId?: string;
      expectedAmountCents?: number;
    },
    @Headers('x-internal-secret') secret?: string
  ) {
    assertInternalSecret(secret);
    return this.aboutTheRequest('request-state', () => this.readNamedRequest(body));
  }

  /** `request-state` past its secret check: see `aboutTheRequest` for what a 400 still means. */
  private async readNamedRequest(body: {
    sessionId?: string;
    orderRef?: string;
    connectAccountId?: string;
    expectedAmountCents?: number;
  }) {
    const bySession =
      typeof body?.sessionId === 'string' &&
      SESSION_ID_RE.test(body.sessionId) &&
      body.orderRef === undefined;
    const byOrderRef =
      body?.sessionId === undefined &&
      typeof body?.orderRef === 'string' &&
      parseLydiaOrderRef(body.orderRef)?.kind === 'product';
    if (
      (!bySession && !byOrderRef) ||
      typeof body.connectAccountId !== 'string' ||
      !body.connectAccountId.trim()
    ) {
      this.logger.warn('request-state refused: invalid payload');
      throw new BadRequestException('Invalid payload');
    }
    const expected = body.expectedAmountCents;
    if (expected !== undefined && (!Number.isSafeInteger(expected) || expected <= 0)) {
      this.logger.warn('request-state refused: invalid expectedAmountCents');
      throw new BadRequestException('Invalid payload');
    }
    const lookup = bySession
      ? { requestUuid: body.sessionId as string }
      : { orderRef: body.orderRef as string };
    if (expected !== undefined) {
      return {
        ok: true,
        ...(await this.paymentService.getVerifiedCheckoutRequestState(
          lookup,
          body.connectAccountId,
          expected
        )),
      };
    }
    const { state, raw } = await this.paymentService.getCheckoutRequestState(
      lookup,
      body.connectAccountId
    );
    return { ok: true, state, raw };
  }

  // THERE IS NO `verify-session` NOR `cancel-session` ANY MORE (2026-10-15). Both read the request
  // by its uuid and took the submission from the `order_ref` the answer was supposed to echo -
  // `request/state` echoes none, with or without the vendor_token (measured on the sandbox,
  // payments.md), so neither could ever name a submission. And no page reached them: Lydia does not
  // fill `{CHECKOUT_SESSION_ID}`, so the return URL carries `submission_id` instead. A payment the
  // callback did not confirm is now read by social-service from the row's own request
  // (`POST forms/submissions/:id/confirm-payment`), through `request-state` above.
}
