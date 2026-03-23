import { Controller, Post, Body, Req, Headers } from '@nestjs/common';
import { PaymentService } from './payment.service';

@Controller('payments')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('onboarding')
  async onboardAssociation(@Body('associationId') associationId: string) {
    return this.paymentService.createOnboardingLink(associationId);
  }

  @Post('create-checkout-session')
  async createCheckout(@Body() body: { eventId: string; options: any }, @Headers('x-user-id') userId: string) {
    return this.paymentService.createCheckoutSession(userId, body.eventId, body.options);
  }
}