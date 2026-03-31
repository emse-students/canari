import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { Post } from './entities/post.entity';
import { HttpModule } from '@nestjs/axios';
import { AssociationsModule } from '../associations/associations.module';

@Module({
  imports: [TypeOrmModule.forFeature([Post]), HttpModule, ConfigModule, AssociationsModule],
  controllers: [PostsController],
  providers: [PostsService],
})
export class PostsModule {}
