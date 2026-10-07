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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { assertInternalSecret } from '../internal/internal-secret.util';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import type { WireLineItem } from './payment-provider.interface';
import axios from 'axios';
import {
  internalSocialRequestConfig,
  internalPaymentAccountUrl,
  internalSubmissionUrl,
} from './social-internal-client';
import { socialUrl } from '../internal/service-urls';
import { describeHttpError } from '../common/http-error-log';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Deliberately loose: the provider is the authority on deliverability, this only refuses junk. */
/**
 * Shape of a payer e-mail. Domain labels exclude the dot so every dot has ONE reading (the old
 * `[^\s@]+\.[^\s@]+` could split a run of dots many ways: polynomial backtracking, CodeQL
 * js/polynomial-redos). Matched only after the `PAYER_EMAIL_MAX_LENGTH` cap, RFC 5321's limit.
 */
const PAYER_EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const PAYER_EMAIL_MAX_LENGTH = 254;
/** A Lydia `request_uuid`, the id of a checkout session. */
export const SESSION_ID_RE = UUID_RE;

/** Controller handling Lydia Business onboarding and checkout sessions. */
@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  /** Marks a form submission as paid via the internal social-service route. */
  private async markSubmissionPaidInternal(
    submissionId: string,
    sessionId?: string
  ): Promise<void> {
    await axios.post(
      internalSubmissionUrl(submissionId, 'mark-paid'),
      sessionId ? { sessionId } : {},
      internalSocialRequestConfig()
    );
  }

  /** Cancels a pending form submission via the internal social-service route. */
  private async cancelPendingSubmissionInternal(submissionId: string): Promise<void> {
    await axios.post(
      internalSubmissionUrl(submissionId, 'cancel-pending'),
      {},
      internalSocialRequestConfig()
    );
  }

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
   * Unlinks an association's Lydia Business from Canari (MANAGE_STRIPE_CONNECT).
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
      stripeConnectAccountId?: string;
      /** Stable key for idempotency, carried to Lydia's request/do as its order_ref. */
      idempotencyKey?: string;
      /** The payer's address, which Lydia's request/do needs as its recipient. Never stored. */
      payerEmail?: string;
    },
    @Headers('x-internal-secret') secret?: string
  ) {
    assertInternalSecret(secret);
    if (!body || !body.lineItems || !Array.isArray(body.lineItems)) {
      throw new BadRequestException('Invalid payload');
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
        stripeConnectAccountId: body.stripeConnectAccountId,
        idempotencyKey: body.idempotencyKey,
      });
      this.logger.debug(`[Payments] Checkout session created: ${session.id}`);
      return { ok: true, url: session.url, id: session.id };
    } catch (err: unknown) {
      // A typed refusal (the Lydia provider's PAYMENT_PROVIDER_REFUSED) is already the answer:
      // re-labelling it would bury both its code and its readable message.
      if (err instanceof HttpException) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`[Payments] create-checkout-session failed: ${msg}`);
      throw new BadRequestException(`Payment error: ${msg}`);
    }
  }

  /** Verifies a completed checkout session and marks the linked form submission as paid. */
  @UseGuards(NginxAuthGuard)
  @Post('verify-session')
  @HttpCode(200)
  async verifySession(@Body() body: { sessionId: string }) {
    if (!body?.sessionId || !SESSION_ID_RE.test(body.sessionId)) {
      throw new BadRequestException('Invalid sessionId');
    }
    if (!(await this.paymentService.isConfigured())) {
      return { ok: false, message: 'Payment provider not configured' };
    }

    const session = await this.paymentService.retrieveSession(body.sessionId);

    if (!session.paid) {
      return { ok: false, message: 'Payment not completed' };
    }

    const submissionId = session.metadata?.submissionId;
    const formId = session.metadata?.formId;

    if (!submissionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId)) {
      this.logger.error(`Missing or invalid submissionId in session ${body.sessionId}`);
      return { ok: false, message: 'No submission linked to this session' };
    }

    try {
      await this.markSubmissionPaidInternal(submissionId, body.sessionId);
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error('verify-session: mark-paid failed', describeHttpError(error));
      // Non-fatal if already paid - webhook may have already handled it
    }

    return { ok: true, submissionId, formId };
  }

  /** Cancels an unpaid checkout session and marks the linked submission as cancelled. */
  @UseGuards(NginxAuthGuard)
  @Post('cancel-session')
  @HttpCode(200)
  async cancelSession(@Body() body: { sessionId: string }) {
    if (!body?.sessionId || !SESSION_ID_RE.test(body.sessionId)) {
      throw new BadRequestException('Invalid sessionId');
    }
    if (!(await this.paymentService.isConfigured())) {
      return { ok: false, message: 'Payment provider not configured' };
    }

    const session = await this.paymentService.retrieveSession(body.sessionId);

    // Safety guard: never cancel a session that was actually paid
    if (session.paid) {
      return { ok: false, message: 'Session already paid' };
    }

    const submissionId = session.metadata?.submissionId;
    const formId = session.metadata?.formId;

    if (!submissionId || !/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId)) {
      return { ok: false, message: 'No submission linked to this session' };
    }

    try {
      await this.cancelPendingSubmissionInternal(submissionId);
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error('cancel-session: cancel submission failed', describeHttpError(error));
    }

    return { ok: true, submissionId, formId };
  }
}
