import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationsModule } from '../associations/associations.module';
import { ModerationModule } from '../moderation/moderation.module';
import { Live } from './entities/live.entity';
import { LiveSegment } from './entities/live-segment.entity';
import { LiveRemovedViewer } from './entities/live-removed-viewer.entity';
import { HttpLiveSegmentStore, LIVE_SEGMENT_STORE } from './live-segment-store';
import { LiveRetentionScheduler } from './live-retention.scheduler';
import { LivesController } from './lives.controller';
import { LivesService } from './lives.service';

/** Every table of the module (migration 091), parent first. */
export const LIVE_ENTITIES = [Live, LiveSegment, LiveRemovedViewer];

/**
 * Lives (docs/wiki/services/lives.md): the row, its key and removed viewers (WP-L2), the segment
 * ingest, the manifest and the sweep (WP-L3). Every route is behind `LIVE_ENABLED`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(LIVE_ENTITIES),
    // The ingest holds its live's row until the store answers, which is what keeps a segment from
    // landing after its live's purge (LivesService). The 30 s bound is what a hung media service may
    // cost that row; the one write it cannot order is a store still running past it, named on
    // docs/wiki/services/lives.md ("What is not proven").
    HttpModule.register({ timeout: 30_000, maxRedirects: 0 }),
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
