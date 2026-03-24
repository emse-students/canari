import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import Stripe from 'stripe';

@Injectable()
export class PaymentService {
  private readonly stripe: Stripe | null;
  private readonly logger = new Logger(PaymentService.name);

  constructor() {
    const key = process.env.STRIPE_SECRET_KEY;
    this.stripe = key
      ? new Stripe(key, { apiVersion: '2026-02-25.clover' })
      : null;
    this.logger.log(`Stripe configured: ${key ? 'yes' : 'no'}`);
  }

  isConfigured(): boolean {
    return !!this.stripe;
  }

  async createCheckoutSession(params: {
    lineItems: Stripe.Checkout.SessionCreateParams.LineItem[];
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
  }) {
    if (!this.stripe) throw new BadRequestException('Stripe not configured');

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: params.lineItems,
      metadata: params.metadata,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
    });

    return session;
  }
}
