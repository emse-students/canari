import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FormsController } from './forms.controller';
import { FormsService } from './forms.service';
import { Form } from './entities/form.entity';
import { Submission } from './entities/submission.entity';
import { AssociationsModule } from '../associations/associations.module';

@Module({
  imports: [TypeOrmModule.forFeature([Form, Submission]), ConfigModule, AssociationsModule],
  controllers: [FormsController],
  providers: [FormsService],
})
export class FormsModule {}
