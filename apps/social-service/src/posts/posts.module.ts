import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { PostInteractionsService } from './post-interactions.service';
import { PostNotificationsService } from './post-notifications.service';
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
    AssociationsModule,
    FollowsModule,
    ModerationModule,
  ],
  controllers: [PostsController],
  providers: [PostsService, PostInteractionsService, PostNotificationsService, PushService],
  exports: [PostNotificationsService],
})
export class PostsModule {}
