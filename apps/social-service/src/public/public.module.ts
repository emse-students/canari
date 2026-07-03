import { Module } from '@nestjs/common';
import { AssociationsModule } from '../associations/associations.module';
import { PublicController } from './public.controller';

/**
 * Groups the unauthenticated read-only endpoints served under `/api/public/*`.
 * Reuses AssociationsService; adds no providers of its own.
 */
@Module({
  imports: [AssociationsModule],
  controllers: [PublicController],
})
export class PublicModule {}
