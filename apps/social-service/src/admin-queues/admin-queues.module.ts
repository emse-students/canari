import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentReport } from '../moderation/entities/content-report.entity';
import { AssociationsModule } from '../associations/associations.module';
import { AdminQueuesService } from './admin-queues.service';
import { AdminQueuesController } from './admin-queues.controller';

/**
 * The admin queues' counts and notices (`AdminQueuesService`). A module of its own so the moderation
 * controller (a report filed) and the internal controller (a profile correction filed, told by
 * core-service) both reach it without importing each other.
 */
@Module({
  imports: [TypeOrmModule.forFeature([ContentReport]), AssociationsModule],
  // `AdminQueueSignal` comes from the global `AdminQueueSignalModule` (app.module).
  providers: [AdminQueuesService],
  controllers: [AdminQueuesController],
  exports: [AdminQueuesService],
})
export class AdminQueuesModule {}
