import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationsModule } from '../associations/associations.module';
import { ModerationModule } from '../moderation/moderation.module';
import { Live } from './entities/live.entity';
import { LiveSegment } from './entities/live-segment.entity';
import { LiveRemovedViewer } from './entities/live-removed-viewer.entity';
import { LiveStart } from './entities/live-start.entity';
import { LIVE_STORE_TIMEOUT_MS } from './live.constants';
import { HttpLiveSegmentStore, LIVE_SEGMENT_STORE } from './live-segment-store';
import { LiveRetentionScheduler } from './live-retention.scheduler';
import { LivesController } from './lives.controller';
import { LivesService } from './lives.service';

/** Every table of the module (migration 091), parent first. */
export const LIVE_ENTITIES = [Live, LiveSegment, LiveRemovedViewer, LiveStart];

/**
 * Lives (docs/wiki/services/lives.md): the row, its key and removed viewers (WP-L2), the segment
 * ingest, the manifest and the sweep (WP-L3). Every route is behind `LIVE_ENABLED`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(LIVE_ENTITIES),
    // The ingest RESERVES its index in a committed step and holds no database connection while it
    // waits here (LivesService.ingest), so this bound costs a broadcaster a slow answer, never the
    // pool. A Garage write still running past it is the orphan the live sweep's reaper takes.
    HttpModule.register({ timeout: LIVE_STORE_TIMEOUT_MS, maxRedirects: 0 }),
    AssociationsModule,
    ModerationModule,
  ],
  controllers: [LivesController],
  providers: [
    LivesService,
    LiveRetentionScheduler,
    { provide: LIVE_SEGMENT_STORE, useClass: HttpLiveSegmentStore },
  ],
})
export class LivesModule {}
