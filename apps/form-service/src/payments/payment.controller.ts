import { Controller, Post, Body, Req, UseGuards } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { SanitizeMongoPipe } from '@canari/shared-ts';

@Controller('payments')
@UseGuards(JwtAuthGuard)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('onboarding')
  async onboardAssociation(@Body('associationId') associationId: string) {
    return this.paymentService.createOnboardingLink(associationId);
  }

  @Post('create-checkout-session')
  async createCheckout(
    @Body(new SanitizeMongoPipe()) body: { eventId: string; options: any },
    @Req() req: any
  ) {
    const userId = req.user.sub;
    return this.paymentService.createCheckoutSession(userId, body.eventId, body.options);
  }
}
