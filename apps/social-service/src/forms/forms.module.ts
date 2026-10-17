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
import { FormFileRetentionScheduler } from './form-file-retention.scheduler';
import { AssociationsModule } from '../associations/associations.module';
import { FormReminderScheduler } from './forms-reminder.scheduler';
import { PushService } from '../push/push.service';
import { PostsModule } from '../posts/posts.module';
import { UserTagModule } from '../users/user-tag.module';
import { PurchaseRecordModule } from '../users/purchase-record.module';
import { PricingModule } from '../pricing/pricing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Form, Submission, FormReminder, FormRespondent, FormFile]),
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
    FormFilesService,
    FormReminderScheduler,
    FormFileRetentionScheduler,
    PushService,
  ],
  exports: [FormsService],
})
export class FormsModule {}
