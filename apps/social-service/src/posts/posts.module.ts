import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PostInteractionsService } from './post-interactions.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostPreviewService } from './post-preview.service';
import { FeedAudienceGuard } from './feed-audience.guard';
import { PostAnnounceScheduler } from './post-announce.scheduler';
import { PostMediaRetentionService } from './post-media-retention.service';
import { Post } from './entities/post.entity';
import { PostNotification } from './entities/post-notification.entity';
import { AssociationsModule } from '../associations/associations.module';
import { FollowsModule } from '../follows/follows.module';
import { PushService } from '../push/push.service';
import { ModerationModule } from '../moderation/moderation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Post, PostNotification]),
    ConfigModule,
    HttpModule.register({ timeout: 30_000, maxRedirects: 0 }),
    AssociationsModule,
    FollowsModule,
    ModerationModule,
  ],
  controllers: [PostsController],
  providers: [
    // A guard with an injected repository is resolved from this module's injector, so it belongs
    // here beside the services. `NginxAuthGuard` needs no entry because it injects nothing.
    FeedAudienceGuard,
    PostsService,
    PostInteractionsService,
    PostNotificationsService,
    PostPreviewService,
    PostAnnounceScheduler,
    PostMediaRetentionService,
    PushService,
  ],
  // `PostPreviewService` is exported for `PublicModule` alone: the unauthenticated link-preview
  // routes live on the `/api/public/` surface, but the rule deciding what a post may disclose
  // belongs beside the posts it reasons about, not in the controller that happens to serve it.
  exports: [PostNotificationsService, PostPreviewService],
})
export class PostsModule {}
