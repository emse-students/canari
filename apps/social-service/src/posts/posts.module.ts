import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { PostNotification } from './entities/post-notification.entity';
import { HttpModule } from '@nestjs/axios';
import { AssociationsModule } from '../associations/associations.module';
import { FollowsModule } from '../follows/follows.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Post, PostNotification]),
    HttpModule,
    ConfigModule,
    AssociationsModule,
    FollowsModule,
  ],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
