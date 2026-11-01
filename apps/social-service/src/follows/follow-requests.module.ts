import { Module } from '@nestjs/common';
import { FollowsModule } from './follows.module';
import { PostsModule } from '../posts/posts.module';
import { ModerationModule } from '../moderation/moderation.module';
import { FollowRequestsController } from './follow-requests.controller';
import { FollowRequestsService } from './follow-requests.service';

/**
 * Following a person and answering requests (WP-F2). A module of its own because it notifies
 * through `PostsModule`'s `PostNotificationsService`, and `PostsModule` already imports
 * `FollowsModule` for the feed - putting this in either would make the two import each other.
 */
@Module({
  imports: [FollowsModule, PostsModule, ModerationModule],
  controllers: [FollowRequestsController],
  providers: [FollowRequestsService],
})
export class FollowRequestsModule {}
