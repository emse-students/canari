import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationsModule } from '../associations/associations.module';
import { Proposal } from './proposal.entity';
import { ProposalsService } from './proposals.service';
import { ProposalsController } from './proposals.controller';

/**
 * Proposals between associations (migration 073). Generic: each kind's handler registers itself
 * from its own module (`repost` from `PostsModule`), so this one imports none of them.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Proposal]), AssociationsModule],
  providers: [ProposalsService],
  controllers: [ProposalsController],
  exports: [ProposalsService],
})
export class ProposalsModule {}
