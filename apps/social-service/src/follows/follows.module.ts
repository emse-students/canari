import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { UserFollowNotice } from './entities/user-follow-notice.entity';
import { Association } from '../associations/entities/association.entity';
import { AssociationPushMute } from './entities/association-push-mute.entity';
import { AssociationPushMutesService } from './association-push-mutes.service';
import { FollowsService } from './follows.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssociationFollow,
      UserFollow,
      UserFollowNotice,
      AssociationPushMute,
      Association,
    ]),
  ],
  providers: [FollowsService, AssociationPushMutesService],
  exports: [FollowsService, AssociationPushMutesService],
})
export class FollowsModule {}
