import { Module } from '@nestjs/common';
import { AssociationsModule } from '../associations/associations.module';
import { PostsModule } from '../posts/posts.module';
import { PublicController } from './public.controller';
import { CercleTopupCreditedController } from './cercle-topup-credited.controller';

/**
 * Groups the endpoints served under `/api/public/*`: the unauthenticated read-only ones
 * (`PublicController`), and Le Cercle's one write, gated on its API key
 * (`CercleTopupCreditedController`). Reuses AssociationsService, ProductsService and
 * PostPreviewService; adds no providers of its own.
 */
@Module({
  imports: [AssociationsModule, PostsModule],
  controllers: [PublicController, CercleTopupCreditedController],
})
export class PublicModule {}
