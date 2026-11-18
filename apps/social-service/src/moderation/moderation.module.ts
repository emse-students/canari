import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentReport } from './entities/content-report.entity';
import { UserModeration } from './entities/user-moderation.entity';
import { ModerationService } from './moderation.service';
import { ModerationController } from './moderation.controller';
import { AssociationsModule } from '../associations/associations.module';
import { AdminQueuesModule } from '../admin-queues/admin-queues.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ContentReport, UserModeration]),
    AssociationsModule,
    // A report filed is announced to the global admins (`AdminQueuesService.announceReport`).
    AdminQueuesModule,
    // The media service, for the media a moderated comment leaves behind (as `PostsModule`'s).
    HttpModule.register({ timeout: 30_000, maxRedirects: 0 }),
  ],
  providers: [ModerationService],
  controllers: [ModerationController],
  exports: [ModerationService],
})
export class ModerationModule {}
