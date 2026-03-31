import {
  Body,
  Controller,
  Post,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { PaymentService } from './payment.service';
import { Stripe } from 'stripe';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('onboarding')
  @HttpCode(200)
  async createOnboarding(
    @Body() body: { associationId: string; existingAccountId?: string },
  ) {
    if (!this.paymentService.isConfigured()) {
      return { ok: false, message: 'Stripe not configured' };
    }
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost';
    return this.paymentService.createConnectOnboarding({
      associationId: body.associationId ?? '',
      existingAccountId: body.existingAccountId,
      refreshUrl: `${frontendUrl}/associations`,
      returnUrl: `${frontendUrl}/associations`,
    });
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
}
