import { Controller, Post, Req, Res, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import Stripe from 'stripe';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

@Controller('payments')
export class PaymentWebhookController {
  private readonly logger = new Logger(PaymentWebhookController.name);
  private readonly stripe: Stripe;

  constructor(private readonly config: ConfigService) {
    const key = this.config.get<string>('STRIPE_SECRET_KEY');
    this.stripe = key
      ? new Stripe(key, { apiVersion: '2025-08-27.basil' })
      : (null as unknown as Stripe);
  }

  @Post('webhook')
  async handle(@Req() req: Request, @Res() res: Response) {
    const webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
    let event: Stripe.Event;

    try {
      if (webhookSecret) {
        const sig = req.headers['stripe-signature'] as string;
        const raw = req.body as Buffer;
        event = this.stripe.webhooks.constructEvent(raw, sig, webhookSecret);
      } else {
        event = req.body as Stripe.Event;
      }
    } catch (err: any) {
      this.logger.error('Webhook signature verification failed', err?.message || err);
      return res.status(400).send(`Webhook Error: ${err?.message || err}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const submissionId = session.metadata?.submissionId as string | undefined;

      if (submissionId) {
        try {
          const formServiceBase =
            this.config.get<string>('FORM_SERVICE_URL') || 'http://localhost:3008';
          const url = `${formServiceBase.replace(/\/$/, '')}/api/forms/submissions/${submissionId}/mark-paid`;
          await axios.post(url, { sessionId: session.id });
          this.logger.log(`Marked submission ${submissionId} as paid via form-service`);
        } catch (err: any) {
          this.logger.error(
            'Failed to notify form-service about payment',
            err?.response?.data || err.message || err
          );
          return res.status(500).send('Failed to notify form-service');
        }
      } else {
        this.logger.warn('checkout.session.completed without submissionId metadata');
      }
    }

    return res.json({ received: true });
  }
}
