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

  @Post('create-checkout-session')
  @HttpCode(200)
  async createCheckout(
    @Body()
    body: {
      lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
      successUrl: string;
      cancelUrl: string;
      metadata?: Record<string, string>;
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
    });

    return { ok: true, url: session.url, id: session.id };
  }
}
