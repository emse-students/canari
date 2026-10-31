import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentWebhookController } from './webhook.controller';
import { RefundController } from './refund.controller';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [PlatformModule],
  controllers: [PaymentController, PaymentWebhookController, RefundController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
