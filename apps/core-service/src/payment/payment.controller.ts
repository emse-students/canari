import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Post,
  HttpCode,
  Param,
  BadRequestException,
  Logger,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PaymentService } from './payment.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { ChargeResult } from './payment.service';
import Stripe from 'stripe';
import axios from 'axios';
import { resolveStripeCallbackUrl } from './stripe-callback-url';
import {
  getSocialServiceBase,
  internalSocialRequestConfig,
  internalProductChargeContextPath,
  internalSubmissionPath,
  productPurchaseCompletedPath,
} from './social-internal-client';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Controller handling Stripe Connect onboarding, checkout sessions, and saved payment methods. */
@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly usersService: UsersService
  ) {}

  /** Base URL for inter-service calls to social-service. */
  private get socialBase(): string {
    return getSocialServiceBase();
  }

  /** Marks a form submission as paid via the internal social-service route. */
  private async markSubmissionPaidInternal(
    submissionId: string,
    sessionId?: string
  ): Promise<void> {
    await axios.post(
      `${this.socialBase}${internalSubmissionPath(submissionId, 'mark-paid')}`,
      sessionId ? { sessionId } : {},
      internalSocialRequestConfig()
    );
  }

  /** Cancels a pending form submission via the internal social-service route. */
  private async cancelPendingSubmissionInternal(submissionId: string): Promise<void> {
    await axios.post(
      `${this.socialBase}${internalSubmissionPath(submissionId, 'cancel-pending')}`,
      {},
      internalSocialRequestConfig()
    );
  }

  /** Fulfills a boutique purchase after a saved-card PaymentIntent succeeds. */
  private async markProductPurchaseCompletedInternal(
    productId: string,
    userId: string,
    amountCents: number,
    paymentIntentId: string
  ): Promise<void> {
    await axios.post(
      `${this.socialBase}${productPurchaseCompletedPath(productId)}`,
      { userId, amountCents, paymentIntentId },
      internalSocialRequestConfig()
    );
  }

  private async assertCanManageAssociation(req: Request, associationId: string): Promise<void> {
    const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    const socialBase = this.socialBase;
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
        `${socialBase}/api/associations/${encodeURIComponent(associationId)}/manage-permission`,
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

  /** Starts or resumes a Stripe Connect onboarding flow for an association and returns the onboarding URL. */
  @Post('onboarding')
  @HttpCode(200)
  async createOnboarding(
    @Body()
    body: {
      associationId: string;
      existingAccountId?: string;
      returnUrl?: string;
      refreshUrl?: string;
    },
    @Req() req: Request
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const assocId = body.associationId?.trim();
    if (assocId) {
      if (!UUID_RE.test(assocId)) {
        throw new BadRequestException('Invalid associationId');
      }
      await this.assertCanManageAssociation(req, assocId);
    }

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost').replace(/\/$/, '');
    const returnUrl = body.returnUrl?.trim() || `${frontendUrl}/associations`;
    const refreshUrl = body.refreshUrl?.trim() || returnUrl;
    const result = await this.paymentService.createConnectOnboarding({
      associationId: body.associationId ?? '',
      existingAccountId: body.existingAccountId,
      refreshUrl,
      returnUrl,
    });

    // Persist the Stripe account ID on the association (social-service)
    if (result.accountId && assocId && UUID_RE.test(assocId)) {
      try {
        const socialBase = this.socialBase;
        await axios.post(
          `${socialBase.replace(/\/$/, '')}/api/associations/${assocId}/stripe-account`,
          { stripeAccountId: result.accountId },
          { maxRedirects: 0 }
        );
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(
          'Failed to save stripeAccountId on association',
          error?.response?.data || error?.message
        );
      }
    }

    return result;
  }

  /**
   * Live Stripe Connect status for an association (MANAGE_STRIPE_CONNECT).
   * Syncs `stripeOnboardingComplete` in social-service when Stripe already enabled charges.
   */
  @Get('connect-status/:associationId')
  async getConnectStatus(@Param('associationId') associationId: string, @Req() req: Request) {
    if (!UUID_RE.test(associationId)) {
      throw new BadRequestException('Invalid associationId');
    }
    await this.assertCanManageAssociation(req, associationId);

    if (!this.paymentService.isConfigured()) {
      return {
        status: 'unavailable' as const,
        message: 'Stripe not configured',
      };
    }

    const socialBase = this.socialBase;

    let stripeAccountId: string | null;
    let dbOnboardingComplete: boolean;
    try {
      const assoRes = await axios.get<{
        stripeAccountId?: string | null;
        stripeOnboardingComplete?: boolean;
      }>(`${socialBase}/api/associations/${encodeURIComponent(associationId)}`, {
        validateStatus: () => true,
      });
      if (assoRes.status >= 400) {
        throw new BadRequestException('Association not found');
      }
      stripeAccountId = assoRes.data.stripeAccountId?.trim() || null;
      dbOnboardingComplete = !!assoRes.data.stripeOnboardingComplete;
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      this.logger.warn(
        `connect-status: failed to load association: ${e instanceof Error ? e.message : String(e)}`
      );
      throw new BadRequestException('Could not load association');
    }

    if (!stripeAccountId) {
      return {
        status: 'not_started' as const,
        dbOnboardingComplete,
        stripeAccountId: null,
      };
    }

    const live = await this.paymentService.getConnectAccountStatus(stripeAccountId);

    if (live.status === 'active' && !dbOnboardingComplete) {
      try {
        await axios.post(
          `${socialBase}/api/associations/${encodeURIComponent(associationId)}/stripe-complete`,
          undefined,
          { maxRedirects: 0, timeout: 15_000 }
        );
        dbOnboardingComplete = true;
        this.logger.log(
          `connect-status: synced stripeOnboardingComplete for association ${associationId}`
        );
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.warn(
          'connect-status: failed to sync stripe-complete',
          error?.response?.data || error?.message
        );
      }
    }

    let balance: Awaited<ReturnType<PaymentService['getConnectBalance']>> | null = null;
    if (live.chargesEnabled && stripeAccountId) {
      try {
        balance = await this.paymentService.getConnectBalance(stripeAccountId);
      } catch (err: unknown) {
        this.logger.warn(
          `connect-status: failed to load balance for ${associationId}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return {
      ...live,
      stripeAccountId,
      dbOnboardingComplete,
      balance,
    };
  }

  /**
   * Returns a single-use Stripe Dashboard login URL for the association's Connect account.
   * Treasurers use it to initiate payouts and manage the linked bank account.
   */
  @Post('connect-dashboard-link/:associationId')
  @HttpCode(200)
  async createConnectDashboardLink(
    @Param('associationId') associationId: string,
    @Req() req: Request
  ) {
    if (!UUID_RE.test(associationId)) {
      throw new BadRequestException('Invalid associationId');
    }
    await this.assertCanManageAssociation(req, associationId);

    if (!this.paymentService.isConfigured()) {
      throw new BadRequestException('Stripe not configured');
    }

    const socialBase = this.socialBase;
    const assoRes = await axios.get<{ stripeAccountId?: string | null }>(
      `${socialBase}/api/associations/${encodeURIComponent(associationId)}`,
      { validateStatus: () => true }
    );
    if (assoRes.status >= 400) {
      throw new BadRequestException('Association not found');
    }

    const stripeAccountId = assoRes.data.stripeAccountId?.trim();
    if (!stripeAccountId) {
      throw new BadRequestException('Stripe Connect is not configured for this association');
    }

    const url = await this.paymentService.createConnectDashboardLink(stripeAccountId);
    return { url };
  }

  /** Creates a Stripe Checkout session for the given line items and returns the session URL. */
  @Post('create-checkout-session')
  @HttpCode(200)
  async createCheckout(
    @Body()
    body: {
      lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
      successUrl: string;
      cancelUrl: string;
      metadata?: Record<string, string>;
      stripeConnectAccountId?: string;
      customerId?: string;
      saveForFuture?: boolean;
    }
  ) {
    if (!body || !body.lineItems || !Array.isArray(body.lineItems)) {
      throw new BadRequestException('Invalid payload');
    }

    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    try {
      const session = await this.paymentService.createCheckoutSession({
        lineItems: body.lineItems,
        successUrl: body.successUrl,
        cancelUrl: body.cancelUrl,
        metadata: body.metadata,
        stripeConnectAccountId: body.stripeConnectAccountId,
        customerId: body.customerId,
        // setup_future_usage is incompatible with destination charges (Connect)
        saveForFuture: body.saveForFuture && !body.stripeConnectAccountId,
      });
      this.logger.debug(`[Stripe] Checkout session created: ${session.id}`);
      return { ok: true, url: session.url, id: session.id };
    } catch (err: unknown) {
      const stripeErr = err as { raw?: { message?: string }; message?: string };
      const msg = stripeErr?.raw?.message ?? stripeErr?.message ?? String(err);
      this.logger.error(`[Stripe] create-checkout-session failed: ${msg}`);
      throw new BadRequestException(`Stripe error: ${msg}`);
    }
  }

  /** Verifies a completed Stripe Checkout session and marks the linked form submission as paid. */
  @Post('verify-session')
  @HttpCode(200)
  async verifySession(@Body() body: { sessionId: string }) {
    if (!body?.sessionId || !/^cs_[a-zA-Z0-9_]+$/.test(body.sessionId)) {
      throw new BadRequestException('Invalid sessionId');
    }
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const session = await this.paymentService.retrieveSession(body.sessionId);

    if (session.payment_status !== 'paid') {
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
      this.logger.error(
        'verify-session: mark-paid failed',
        error?.response?.data || error?.message
      );
      // Non-fatal if already paid - webhook may have already handled it
    }

    return { ok: true, submissionId, formId };
  }

  /** Cancels an unpaid Stripe Checkout session and marks the linked submission as cancelled. */
  @Post('cancel-session')
  @HttpCode(200)
  async cancelSession(@Body() body: { sessionId: string }) {
    if (!body?.sessionId || !/^cs_[a-zA-Z0-9_]+$/.test(body.sessionId)) {
      throw new BadRequestException('Invalid sessionId');
    }
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const session = await this.paymentService.retrieveSession(body.sessionId);

    // Safety guard: never cancel a session that was actually paid
    if (session.payment_status === 'paid') {
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
      this.logger.error(
        'cancel-session: cancel submission failed',
        error?.response?.data || error?.message
      );
    }

    return { ok: true, submissionId, formId };
  }

  // ── Payment Methods (user) ────────────────────────────────────────────────

  /** Creates a Stripe Setup Checkout session so the authenticated user can save a card for future charges. */
  @UseGuards(NginxAuthGuard)
  @Post('setup-payment-method')
  @HttpCode(200)
  async setupPaymentMethod(
    @Headers('x-user-id') userId: string,
    @Body() body: { successUrl?: string; cancelUrl?: string } = {}
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const user = await this.usersService.findOne(userId);
    const customerId = await this.paymentService.getOrCreateCustomer(user.stripeCustomerId, {
      userId: user.id,
      displayName: user.displayName,
    });

    // Save customer ID if it was just created
    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(userId, {
        stripeCustomerId: customerId,
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
    const result = await this.paymentService.createSetupCheckoutSession({
      customerId,
      successUrl: resolveStripeCallbackUrl(
        body?.successUrl,
        `${frontendUrl}/profile?payment_setup=success`,
        frontendUrl
      ),
      cancelUrl: resolveStripeCallbackUrl(
        body?.cancelUrl,
        `${frontendUrl}/profile?payment_setup=cancel`,
        frontendUrl
      ),
    });

    return { ok: true, url: result.url };
  }

  /** Returns all saved card payment methods for the authenticated user. */
  @UseGuards(NginxAuthGuard)
  @Get('payment-methods')
  async listPaymentMethods(@Headers('x-user-id') userId: string) {
    if (!this.paymentService.isConfigured()) {
      return [];
    }

    const user = await this.usersService.findOne(userId);
    if (!user.stripeCustomerId) return [];

    return this.paymentService.listPaymentMethods(user.stripeCustomerId);
  }

  /** Detaches a saved payment method from the authenticated user's Stripe customer. */
  @UseGuards(NginxAuthGuard)
  @Delete('payment-methods/:id')
  async deletePaymentMethod(
    @Headers('x-user-id') userId: string,
    @Param('id') paymentMethodId: string
  ) {
    if (!this.paymentService.isConfigured()) {
      throw new BadRequestException('Stripe not configured');
    }

    // Verify the payment method belongs to this user's customer
    const user = await this.usersService.findOne(userId);
    if (!user.stripeCustomerId) {
      throw new BadRequestException('No payment methods on file');
    }

    const methods = await this.paymentService.listPaymentMethods(user.stripeCustomerId);
    if (!methods.some((m) => m.id === paymentMethodId)) {
      throw new BadRequestException('Payment method not found');
    }

    await this.paymentService.detachPaymentMethod(paymentMethodId);
    return { ok: true };
  }

  // ── Internal (server-to-server) ──────────────────────────────────────────

  /**
   * Returns the Stripe customer ID for a user, creating one if necessary.
   * Called by social-service when creating a checkout session for a paid form.
   * Protected by NginxAuthGuard so it rejects direct requests bypassing nginx.
   */
  @UseGuards(NginxAuthGuard)
  @Post('internal/customer-id')
  @HttpCode(200)
  async getOrCreateCustomerForUser(
    @Body() body: { userId: string }
  ): Promise<{ customerId: string | null }> {
    if (!this.paymentService.isConfigured()) {
      return { customerId: null };
    }
    if (!body?.userId || !/^[a-zA-Z0-9_@.-]{1,256}$/.test(body.userId)) {
      throw new BadRequestException('Invalid userId');
    }

    let user: User;
    try {
      user = await this.usersService.findOne(body.userId);
    } catch {
      return { customerId: null };
    }

    const customerId = await this.paymentService.getOrCreateCustomer(user.stripeCustomerId, {
      userId: user.id,
      displayName: user.displayName,
    });

    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(body.userId, {
        stripeCustomerId: customerId,
      });
    }

    return { customerId };
  }

  /** Charges a saved payment method for a form submission, marking it as paid on success. */
  @UseGuards(NginxAuthGuard)
  @Post('charge-saved-method')
  @HttpCode(200)
  async chargeWithSavedMethod(
    @Headers('x-user-id') userId: string,
    @Body() body: { submissionId: string; paymentMethodId: string }
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const { submissionId, paymentMethodId } = body;
    if (!submissionId || !paymentMethodId) {
      throw new BadRequestException('submissionId and paymentMethodId are required');
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId)) {
      throw new BadRequestException('Invalid submissionId');
    }

    // Ensure user has a Stripe customer and this PM belongs to them
    const user = await this.usersService.findOne(userId);
    const customerId = await this.paymentService.getOrCreateCustomer(user.stripeCustomerId, {
      userId: user.id,
      displayName: user.displayName,
    });
    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(userId, { stripeCustomerId: customerId });
    }

    const methods = await this.paymentService.listPaymentMethods(customerId);
    if (!methods.some((m) => m.id === paymentMethodId)) {
      throw new BadRequestException('Payment method not found or does not belong to this account');
    }

    // Fetch submission details from social-service
    const socialBase = this.socialBase;

    interface SubmissionData {
      userId: string;
      paymentStatus: string;
      totalPaid: number;
      currency: string;
      stripeAccountId: string | null;
    }

    let submissionData: SubmissionData;
    try {
      const resp = await axios.get<SubmissionData>(
        `${socialBase}${internalSubmissionPath(submissionId)}`,
        internalSocialRequestConfig()
      );
      submissionData = resp.data;
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error('Failed to fetch submission', error?.response?.data || error?.message);
      throw new BadRequestException('Could not retrieve submission details');
    }

    if (submissionData.userId.toLowerCase() !== userId.toLowerCase()) {
      throw new BadRequestException('Submission does not belong to this user');
    }

    if (submissionData.paymentStatus === 'paid') {
      return { ok: true, alreadyPaid: true };
    }
    if (submissionData.paymentStatus === 'cancelled') {
      return {
        ok: false,
        error: 'This submission has been cancelled. Please submit the form again.',
      };
    }
    if (submissionData.paymentStatus === 'free' || !submissionData.totalPaid) {
      return { ok: true, noPaymentRequired: true };
    }

    // Charge - idempotencyKey prevents double-charge on client retry.
    const result: ChargeResult = await this.paymentService.chargeWithSavedMethod({
      customerId,
      paymentMethodId,
      amountCents: submissionData.totalPaid,
      currency: submissionData.currency ?? 'eur',
      metadata: { submissionId, userId },
      stripeConnectAccountId: submissionData.stripeAccountId ?? undefined,
      idempotencyKey: `${submissionId}:${paymentMethodId}`,
    });

    if (result.ok) {
      try {
        await this.markSubmissionPaidInternal(submissionId);
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(
          'Failed to mark submission as paid',
          error?.response?.data || error?.message
        );
        // Payment succeeded but marking failed - return ok, user can retry
      }
    } else if (!result.requiresAction) {
      try {
        await this.cancelPendingSubmissionInternal(submissionId);
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(
          'Failed to cancel submission after charge failure',
          error?.response?.data || error?.message
        );
      }
    }

    return result;
  }

  /** Charges a saved payment method for a boutique product purchase. */
  @UseGuards(NginxAuthGuard)
  @Post('charge-product-saved-method')
  @HttpCode(200)
  async chargeProductWithSavedMethod(
    @Headers('x-user-id') userId: string,
    @Body()
    body: {
      associationId: string;
      productId: string;
      paymentMethodId: string;
      customAmountCents?: number;
    }
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const { associationId, productId, paymentMethodId, customAmountCents } = body;
    if (!associationId || !productId || !paymentMethodId) {
      throw new BadRequestException('associationId, productId and paymentMethodId are required');
    }
    if (!UUID_RE.test(associationId) || !UUID_RE.test(productId)) {
      throw new BadRequestException('Invalid associationId or productId');
    }

    const user = await this.usersService.findOne(userId);
    const customerId = await this.paymentService.getOrCreateCustomer(user.stripeCustomerId, {
      userId: user.id,
      displayName: user.displayName,
    });
    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(userId, { stripeCustomerId: customerId });
    }

    const methods = await this.paymentService.listPaymentMethods(customerId);
    if (!methods.some((m) => m.id === paymentMethodId)) {
      throw new BadRequestException('Payment method not found or does not belong to this account');
    }

    interface ProductChargeContext {
      userId: string;
      amountCents: number;
      currency: string;
      stripeAccountId: string;
      productId: string;
    }

    let chargeContext: ProductChargeContext;
    try {
      const resp = await axios.post<ProductChargeContext>(
        `${this.socialBase}${internalProductChargeContextPath()}`,
        { associationId, productId, userId, customAmountCents },
        internalSocialRequestConfig()
      );
      chargeContext = resp.data;
    } catch (err: unknown) {
      const error = err as Error & {
        response?: { data?: { message?: string } };
      };
      this.logger.error(
        'Failed to fetch product charge context',
        error?.response?.data || error?.message
      );
      const msg = error?.response?.data?.message ?? 'Could not retrieve product purchase details';
      throw new BadRequestException(msg);
    }

    if (chargeContext.userId.toLowerCase() !== userId.toLowerCase()) {
      throw new BadRequestException('Product purchase does not belong to this user');
    }

    if (!chargeContext.amountCents || chargeContext.amountCents <= 0) {
      return { ok: true, noPaymentRequired: true };
    }

    const idempotencyKey = `${productId}:${userId}:${chargeContext.amountCents}:${paymentMethodId}`;
    const result: ChargeResult = await this.paymentService.chargeWithSavedMethod({
      customerId,
      paymentMethodId,
      amountCents: chargeContext.amountCents,
      currency: chargeContext.currency ?? 'eur',
      metadata: { productId, userId },
      stripeConnectAccountId: chargeContext.stripeAccountId,
      idempotencyKey,
    });

    if (result.ok && result.paymentIntentId) {
      try {
        await this.markProductPurchaseCompletedInternal(
          productId,
          userId,
          chargeContext.amountCents,
          result.paymentIntentId
        );
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(
          'Failed to fulfill product purchase after charge',
          error?.response?.data || error?.message
        );
      }
    }

    return result;
  }
}
