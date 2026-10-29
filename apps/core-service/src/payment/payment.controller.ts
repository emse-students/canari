import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  HttpCode,
  Param,
  BadRequestException,
  HttpException,
  Logger,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
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
import { PAYMENT_PROVIDER_REFUSED } from './lydia-payment-provider';

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

/** Controller handling Lydia Business onboarding and checkout sessions. */
@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  private async assertCanManageAssociation(req: Request, associationId: string): Promise<void> {
    const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    const fwd: Record<string, string> = {
      'X-User-Id': userId,
      'X-Global-Admin': req.headers['x-global-admin'] === 'true' ? 'true' : 'false',
    };
    const nginxAuth = req.headers['x-nginx-auth'];
    if (typeof nginxAuth === 'string') fwd['X-Nginx-Auth'] = nginxAuth;
    const authz = req.headers['authorization'];
    if (typeof authz === 'string') fwd['Authorization'] = authz;
    // Forward the Nginx-generated HMAC token so social-service's NginxAuthGuard
    // can validate the inter-service call when INTERNAL_SHARED_SECRET is configured.
    const internalToken = req.headers['x-internal-token'];
    if (typeof internalToken === 'string') fwd['X-Internal-Token'] = internalToken;

    try {
      const res = await axios.get<{ ok: boolean }>(
        socialUrl(`associations/${encodeURIComponent(associationId)}/manage-permission`),
        { headers: fwd, validateStatus: () => true }
      );
      if (res.status >= 400 || !res.data?.ok) {
        throw new ForbiddenException('You cannot manage payments for this association');
      }
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof UnauthorizedException) throw e;
      this.logger.warn(
        `manage-permission check failed: ${e instanceof Error ? e.message : String(e)}`
      );
      throw new BadRequestException('Could not verify association permissions');
    }
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
    await this.assertCanManageAssociation(req, assocId);

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
    const result = await this.paymentService.createConnectOnboarding({
      associationId: body.associationId ?? '',
      existingAccountId: body.existingAccountId,
      refreshUrl,
      returnUrl,
      legalProfile,
    });

    // Persist the Lydia Business `vendor_token` on the association (social-service).
    if (result.accountId && assocId && UUID_RE.test(assocId)) {
      // Lydia's dashboard_url is handed out exactly once, at business/create, so it must be
      // captured here or it is gone for good.
      const bodyKey = 'lydiaAccountId';
      const body: Record<string, string> = { [bodyKey]: result.accountId };
      if (result.url) body.lydiaDashboardUrl = result.url;
      try {
        await axios.post(
          socialUrl(`associations/${assocId}/lydia-account`),
          body,
          internalSocialRequestConfig()
        );
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(`Failed to save ${bodyKey} on association`, describeHttpError(error));
      }
    }

    return result;
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
   * Validates a Lydia onboarding BY HAND (global admin only).
   *
   * Nothing marks `lydiaOnboardingComplete` automatically: `business/create`'s callback carries no
   * signature, so no receiver was built (see the core-service wiki page). A platform admin who has
   * seen Lydia accept the club's file says so here. It is NOT open to the club's own managers - they
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
