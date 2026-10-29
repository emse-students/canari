import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormsController } from './forms.controller';
import { PublicFormsController } from './public-forms.controller';
import { FormsService } from './forms.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { FormRespondent } from './entities/form-respondent.entity';
import { FormFile } from './entities/form-file.entity';
import { FormFilesService } from './form-files.service';
import { FormOrganiserAlertService } from './organiser-alert.service';
import { FormFileRetentionScheduler } from './form-file-retention.scheduler';
import { AssociationsModule } from '../associations/associations.module';
import { FormReminderScheduler } from './forms-reminder.scheduler';
import { PushService } from '../push/push.service';
import { PostsModule } from '../posts/posts.module';
import { UserTagModule } from '../users/user-tag.module';
import { PurchaseRecordModule } from '../users/purchase-record.module';
import { PricingModule } from '../pricing/pricing.module';
import { ProductCheckout } from '../associations/entities/product-checkout.entity';
import { LydiaReconciliationService } from './lydia-reconciliation.service';
import { LydiaReconciliationScheduler } from './lydia-reconciliation.scheduler';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Form,
      Submission,
      FormReminder,
      FormRespondent,
      FormFile,
      // The boutique attempts the Lydia reconciliation reads (`lydia-reconciliation.service.ts`).
      ProductCheckout,
    ]),
    HttpModule.register({ timeout: 30_000, maxRedirects: 0 }),
    ConfigModule,
    AssociationsModule,
    PostsModule,
    UserTagModule,
    PurchaseRecordModule,
    PricingModule,
  ],
  controllers: [FormsController, PublicFormsController],
  providers: [
    FormsService,
    FormOrganiserAlertService,
    FormFilesService,
    FormReminderScheduler,
    FormFileRetentionScheduler,
    LydiaReconciliationService,
    LydiaReconciliationScheduler,
    PushService,
  ],
  // FormFilesService: the store and the purge of the `form-file` class, which a booking's file
  // answers use too (BookingsModule, WP-B6).
  exports: [FormsService, FormFilesService],
})
export class FormsModule {}
