import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationsModule } from '../associations/associations.module';
import { AssociationCalendarEventCoOwner } from '../associations/entities/association-calendar-event-co-owner.entity';
import { PostsModule } from '../posts/posts.module';
import { ProposalsModule } from '../proposals/proposals.module';
import { CoorganisationController } from './coorganisation.controller';
import { CoorganisationService } from './coorganisation.service';

/**
 * Event co-organisation by proposal (D39). Its own module because it needs the associations (the
 * events, `mayAct`), the proposals and the notifications, and `AssociationsModule` may import none
 * of those back: the service registers itself with both `ProposalsService` (the `coorganise` kind)
 * and `AssociationsService` (`co-organisers.port`) at boot.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([AssociationCalendarEventCoOwner]),
    AssociationsModule,
    ProposalsModule,
    PostsModule,
  ],
  providers: [CoorganisationService],
  controllers: [CoorganisationController],
})
export class CoorganisationModule {}
