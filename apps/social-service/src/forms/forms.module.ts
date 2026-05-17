import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormsController } from './forms.controller';
import { FormsService } from './forms.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { FormReminder } from './entities/form-reminder.entity';
import { AssociationsModule } from '../associations/associations.module';
import { FormReminderScheduler } from './forms-reminder.scheduler';
import { PushService } from '../push/push.service';

@Module({
  imports: [TypeOrmModule.forFeature([Form, Submission, FormReminder]), ConfigModule, AssociationsModule],
  controllers: [FormsController],
  providers: [FormsService, FormReminderScheduler, PushService],
})
export class FormsModule {}
