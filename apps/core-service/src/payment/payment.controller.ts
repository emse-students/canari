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
import { Stripe } from 'stripe';
import axios from 'axios';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly usersService: UsersService,
  ) {}

  private async assertCanManageAssociation(req: Request, associationId: string): Promise<void> {
    const userId = (req.headers['x-user-id'] as string | undefined)?.trim();
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    const socialBase = (process.env.FORM_URL || 'http://social-service:3014').replace(/\/$/, '');
    const fwd: Record<string, string> = {
      'X-User-Id': userId,
      'X-Global-Admin': req.headers['x-global-admin'] === 'true' ? 'true' : 'false',
    };
    const nginxAuth = req.headers['x-nginx-auth'];
    if (typeof nginxAuth === 'string') fwd['X-Nginx-Auth'] = nginxAuth;
    const authz = req.headers['authorization'];
    if (typeof authz === 'string') fwd['Authorization'] = authz;

    try {
      const res = await axios.get<{ ok: boolean }>(
        `${socialBase}/api/associations/${encodeURIComponent(associationId)}/manage-permission`,
        { headers: fwd, validateStatus: () => true },
      );
      if (res.status >= 400 || !res.data?.ok) {
        throw new ForbiddenException('You cannot manage payments for this association');
      }
    } catch (e) {
      if (e instanceof ForbiddenException || e instanceof UnauthorizedException) throw e;
      this.logger.warn(`manage-permission check failed: ${e}`);
      throw new BadRequestException('Could not verify association permissions');
    }
  }

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
    @Req() req: Request,
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
        const socialBase = process.env.FORM_URL || 'http://localhost:3014';
        await axios.post(
          `${socialBase.replace(/\/$/, '')}/api/associations/${assocId}/stripe-account`,
          { stripeAccountId: result.accountId },
          { maxRedirects: 0 },
        );
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(
          'Failed to save stripeAccountId on association',
          error?.response?.data || error?.message,
        );
      }
    }

    return result;
  }

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
    },
  ) {
    if (!body || !body.lineItems || !Array.isArray(body.lineItems)) {
      throw new BadRequestException('Invalid payload');
    }

    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const session = await this.paymentService.createCheckoutSession({
      lineItems: body.lineItems,
      successUrl: body.successUrl,
      cancelUrl: body.cancelUrl,
      metadata: body.metadata,
      stripeConnectAccountId: body.stripeConnectAccountId,
      customerId: body.customerId,
      saveForFuture: body.saveForFuture,
    });

    return { ok: true, url: session.url, id: session.id };
  }

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
      this.logger.error(
        `Missing or invalid submissionId in session ${body.sessionId}`,
      );
      return { ok: false, message: 'No submission linked to this session' };
    }

    try {
      const socialBase = process.env.FORM_URL || 'http://localhost:3014';
      await axios.post(
        `${socialBase.replace(/\/$/, '')}/api/forms/submissions/${submissionId}/mark-paid`,
        { sessionId: body.sessionId },
        { maxRedirects: 0 },
      );
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error(
        'verify-session: mark-paid failed',
        error?.response?.data || error?.message,
      );
      // Non-fatal if already paid — webhook may have already handled it
    }

    return { ok: true, submissionId, formId };
  }

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
      const socialBase = process.env.FORM_URL || 'http://localhost:3014';
      await axios.post(
        `${socialBase.replace(/\/$/, '')}/api/forms/submissions/${submissionId}/cancel`,
        {},
        { maxRedirects: 0 },
      );
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error(
        'cancel-session: cancel submission failed',
        error?.response?.data || error?.message,
      );
    }

    return { ok: true, submissionId, formId };
  }

  // ── Payment Methods (user) ────────────────────────────────────────────────

  @UseGuards(NginxAuthGuard)
  @Post('setup-payment-method')
  @HttpCode(200)
  async setupPaymentMethod(@Headers('x-user-id') userId: string) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const user = await this.usersService.findOne(userId);
    const customerId = await this.paymentService.getOrCreateCustomer(
      user.stripeCustomerId,
      { userId: user.id, displayName: user.displayName },
    );

    // Save customer ID if it was just created
    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(userId, {
        stripeCustomerId: customerId,
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
    const result = await this.paymentService.createSetupCheckoutSession({
      customerId,
      successUrl: `${frontendUrl}/profile?payment_setup=success`,
      cancelUrl: `${frontendUrl}/profile?payment_setup=cancel`,
    });

    return { ok: true, url: result.url };
  }

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

  @UseGuards(NginxAuthGuard)
  @Delete('payment-methods/:id')
  async deletePaymentMethod(
    @Headers('x-user-id') userId: string,
    @Param('id') paymentMethodId: string,
  ) {
    if (!this.paymentService.isConfigured()) {
      throw new BadRequestException('Stripe not configured');
    }

    // Verify the payment method belongs to this user's customer
    const user = await this.usersService.findOne(userId);
    if (!user.stripeCustomerId) {
      throw new BadRequestException('No payment methods on file');
    }

    const methods = await this.paymentService.listPaymentMethods(
      user.stripeCustomerId,
    );
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
   * Not exposed to end-users — no auth guard needed (internal traffic only).
   */
  @Post('internal/customer-id')
  @HttpCode(200)
  async getOrCreateCustomerForUser(
    @Body() body: { userId: string },
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

    const customerId = await this.paymentService.getOrCreateCustomer(
      user.stripeCustomerId,
      { userId: user.id, displayName: user.displayName },
    );

    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(body.userId, {
        stripeCustomerId: customerId,
      });
    }

    return { customerId };
  }

  @UseGuards(NginxAuthGuard)
  @Post('charge-saved-method')
  @HttpCode(200)
  async chargeWithSavedMethod(
    @Headers('x-user-id') userId: string,
    @Body() body: { submissionId: string; paymentMethodId: string },
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }

    const { submissionId, paymentMethodId } = body;
    if (!submissionId || !paymentMethodId) {
      throw new BadRequestException(
        'submissionId and paymentMethodId are required',
      );
    }
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(submissionId)) {
      throw new BadRequestException('Invalid submissionId');
    }

    // Ensure user has a Stripe customer and this PM belongs to them
    const user = await this.usersService.findOne(userId);
    const customerId = await this.paymentService.getOrCreateCustomer(
      user.stripeCustomerId,
      { userId: user.id, displayName: user.displayName },
    );
    if (customerId !== user.stripeCustomerId) {
      await this.usersService.update(userId, { stripeCustomerId: customerId });
    }

    const methods = await this.paymentService.listPaymentMethods(customerId);
    if (!methods.some((m) => m.id === paymentMethodId)) {
      throw new BadRequestException(
        'Payment method not found or does not belong to this account',
      );
    }

    // Fetch submission details from social-service
    const socialBase = process.env.FORM_URL || 'http://localhost:3014';

    interface SubmissionData {
      paymentStatus: string;
      totalPaid: number;
      currency: string;
      stripeAccountId: string | null;
    }

    let submissionData: SubmissionData;
    try {
      const resp = await axios.get<SubmissionData>(
        `${socialBase.replace(/\/$/, '')}/api/forms/submissions/${submissionId}`,
        { maxRedirects: 0 },
      );
      submissionData = resp.data;
    } catch (err: unknown) {
      const error = err as Error & { response?: { data?: unknown } };
      this.logger.error(
        'Failed to fetch submission',
        error?.response?.data || error?.message,
      );
      throw new BadRequestException('Could not retrieve submission details');
    }

    if (submissionData.paymentStatus === 'paid') {
      return { ok: true, alreadyPaid: true };
    }
    if (submissionData.paymentStatus === 'free' || !submissionData.totalPaid) {
      return { ok: true, noPaymentRequired: true };
    }

    // Charge
    const result: ChargeResult =
      await this.paymentService.chargeWithSavedMethod({
        customerId,
        paymentMethodId,
        amountCents: submissionData.totalPaid,
        currency: submissionData.currency ?? 'eur',
        metadata: { submissionId, userId },
        stripeConnectAccountId: submissionData.stripeAccountId ?? undefined,
      });

    if (result.ok) {
      // Mark submission as paid
      try {
        await axios.post(
          `${socialBase.replace(/\/$/, '')}/api/forms/submissions/${submissionId}/mark-paid`,
          {},
          { maxRedirects: 0 },
        );
      } catch (err: unknown) {
        const error = err as Error & { response?: { data?: unknown } };
        this.logger.error(
          'Failed to mark submission as paid',
          error?.response?.data || error?.message,
        );
        // Payment succeeded but marking failed — return ok, user can retry
      }
    }

    return result;
  }
}
