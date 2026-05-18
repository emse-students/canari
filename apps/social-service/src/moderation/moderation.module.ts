import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentReport } from './entities/content-report.entity';
import { UserModeration } from './entities/user-moderation.entity';
import { ModerationService } from './moderation.service';
import { ModerationController } from './moderation.controller';
import { AssociationsModule } from '../associations/associations.module';

@Module({
  imports: [TypeOrmModule.forFeature([ContentReport, UserModeration]), AssociationsModule],
  providers: [ModerationService],
  controllers: [ModerationController],
  exports: [ModerationService],
})
export class ModerationModule {}
