import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { LydiaCashiersController } from './lydia-cashiers.controller';
import { PaymentService } from './payment.service';
import { PaymentWebhookController } from './webhook.controller';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [PlatformModule],
  controllers: [PaymentController, PaymentWebhookController, LydiaCashiersController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
