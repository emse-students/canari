import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { CommentIdentityService } from './comment-identity';
import { PostInteractionsService } from './post-interactions.service';
import { PostNotificationsService } from './post-notifications.service';
import { PostPreviewService } from './post-preview.service';
import { FeedAudienceGuard } from './feed-audience.guard';
import { PostAnnounceScheduler } from './post-announce.scheduler';
import { PostMediaRetentionService } from './post-media-retention.service';
import { ReelRetentionScheduler } from './reel-retention.scheduler';
import { Post } from './entities/post.entity';
import { PostNotification } from './entities/post-notification.entity';
import { PostRepublication } from './entities/post-republication.entity';
import { RepublicationsService } from './republications.service';
import { RepublicationsController } from './republications.controller';
import { PersonalRepublicationsService } from './personal-republications.service';
import { MemberRepost } from './entities/member-repost.entity';
import { UserRepostSetting } from './entities/user-repost-setting.entity';
import { MemberRepostsService } from './member-reposts.service';
import { MemberRepostsController } from './member-reposts.controller';
import { ProposalsModule } from '../proposals/proposals.module';
import { AssociationsModule } from '../associations/associations.module';
import { FollowsModule } from '../follows/follows.module';
import { PushService } from '../push/push.service';
import { ModerationModule } from '../moderation/moderation.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Post,
      PostNotification,
      PostRepublication,
      MemberRepost,
      UserRepostSetting,
    ]),
    ConfigModule,
    HttpModule.register({ timeout: 30_000, maxRedirects: 0 }),
    AssociationsModule,
    FollowsModule,
    ModerationModule,
    // The generic proposals; this module registers their `repost` kind (`RepublicationsService`)
    // and their `repost-personal` kind (`PersonalRepublicationsService`, D38b).
    ProposalsModule,
  ],
  controllers: [PostsController, RepublicationsController, MemberRepostsController],
  providers: [
    // A guard with an injected repository is resolved from this module's injector, so it belongs
    // here beside the services. `NginxAuthGuard` needs no entry because it injects nothing.
    FeedAudienceGuard,
    PostsService,
    PostInteractionsService,
    CommentIdentityService,
    PostNotificationsService,
    PostPreviewService,
    PostAnnounceScheduler,
    PostMediaRetentionService,
    ReelRetentionScheduler,
    RepublicationsService,
    // D38b: the `repost-personal` kind, whose receiver is the post's author.
    PersonalRepublicationsService,
    // WP-F6: a person reposts to their own accepted followers.
    MemberRepostsService,
    PushService,
  ],
  // `PostPreviewService` is exported for `PublicModule` alone: the unauthenticated link-preview
  // routes live on the `/api/public/` surface, but the rule deciding what a post may disclose
  // belongs beside the posts it reasons about, not in the controller that happens to serve it.
  exports: [PostNotificationsService, PostPreviewService, PostMediaRetentionService],
})
export class PostsModule {}
