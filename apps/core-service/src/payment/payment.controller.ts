import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Post,
  HttpCode,
  Param,
  BadRequestException,
  Logger,
  UseGuards,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { UsersService } from '../users/users.service';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { Stripe } from 'stripe';
import axios from 'axios';

@Controller('payments')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly usersService: UsersService,
  ) {}

  @Post('onboarding')
  @HttpCode(200)
  async createOnboarding(
    @Body() body: { associationId: string; existingAccountId?: string },
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
    const result = await this.paymentService.createConnectOnboarding({
      associationId: body.associationId ?? '',
      existingAccountId: body.existingAccountId,
      refreshUrl: `${frontendUrl}/associations`,
      returnUrl: `${frontendUrl}/associations`,
    });

    // Persist the Stripe account ID on the association (social-service)
    if (result.accountId && body.associationId) {
      try {
        const socialBase = process.env.FORM_URL || 'http://localhost:3014';
        await axios.post(
          `${socialBase.replace(/\/$/, '')}/api/associations/${body.associationId}/stripe-account`,
          { stripeAccountId: result.accountId },
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
    });

    return { ok: true, url: session.url, id: session.id };
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
}
