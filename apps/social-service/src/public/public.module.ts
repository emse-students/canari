import { Module } from '@nestjs/common';
import { AssociationsModule } from '../associations/associations.module';
import { PostsModule } from '../posts/posts.module';
import { PublicController } from './public.controller';

/**
 * Groups the unauthenticated read-only endpoints served under `/api/public/*`.
 * Reuses AssociationsService and PostPreviewService; adds no providers of its own.
 */
@Module({
  imports: [AssociationsModule, PostsModule],
  controllers: [PublicController],
})
export class PublicModule {}
