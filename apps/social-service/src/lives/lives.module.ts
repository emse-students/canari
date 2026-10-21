import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationsModule } from '../associations/associations.module';
import { ModerationModule } from '../moderation/moderation.module';
import { PostsModule } from '../posts/posts.module';
import { Live } from './entities/live.entity';
import { LiveSegment } from './entities/live-segment.entity';
import { LiveRemovedViewer } from './entities/live-removed-viewer.entity';
import { LiveStart } from './entities/live-start.entity';
import { LiveCut } from './entities/live-cut.entity';
import { LiveRulesAcceptance } from './entities/live-rules-acceptance.entity';
import { LiveChatMessage } from './entities/live-chat-message.entity';
import { LiveReactionBurst } from './entities/live-reaction-burst.entity';
import { LiveBroadcastWithdrawal } from './entities/live-broadcast-withdrawal.entity';
import { LiveChatReportedLine } from './entities/live-chat-reported-line.entity';
import { LIVE_STORE_TIMEOUT_MS } from './live.constants';
import { HttpLiveSegmentStore, LIVE_SEGMENT_STORE } from './live-segment-store';
import { LiveRetentionScheduler } from './live-retention.scheduler';
import { LiveReportAgeScheduler } from './live-report-age.scheduler';
import { LiveAnnouncer } from './live-announcer';
import { LiveSeats } from './live-seats';
import { LiveChatController } from './live-chat.controller';
import { LiveChatService } from './live-chat.service';
import { LivesController } from './lives.controller';
import { LivesService } from './lives.service';

/** Every table of the module (migrations 091, 094, 097, 098 and 099), parent first. */
export const LIVE_ENTITIES = [
  Live,
  LiveSegment,
  LiveRemovedViewer,
  LiveStart,
  LiveCut,
  LiveRulesAcceptance,
  LiveChatMessage,
  LiveReactionBurst,
  LiveBroadcastWithdrawal,
  LiveChatReportedLine,
];

/**
 * Lives (docs/wiki/services/lives.md): the row, its key and removed viewers (WP-L2), the segment
 * ingest, the manifest and the sweep (WP-L3), and the push to the followers when a live goes on air
 * (WP-L7, server half), and the live chat and floating reactions (WP-L6). Every route, and that
 * push, is behind `LIVE_ENABLED`; the sweep and the hourly report-age alarm run regardless.
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
    // `PostNotificationsService`: a live's start is pushed through the post notices' one pipeline.
    PostsModule,
  ],
  controllers: [LivesController, LiveChatController],
  providers: [
    LivesService,
    LiveRetentionScheduler,
    LiveReportAgeScheduler,
    LiveAnnouncer,
    LiveSeats,
    LiveChatService,
    { provide: LIVE_SEGMENT_STORE, useClass: HttpLiveSegmentStore },
  ],
})
export class LivesModule {}
