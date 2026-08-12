import { Module } from '@nestjs/common';
import { PaymentController } from './payment.controller';
import { PaymentService } from './payment.service';
import { PaymentWebhookController } from './webhook.controller';
import { UsersModule } from '../users/users.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [UsersModule, PlatformModule],
  controllers: [PaymentController, PaymentWebhookController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}
