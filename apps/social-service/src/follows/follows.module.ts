import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { UserFollowNotice } from './entities/user-follow-notice.entity';
import { Association } from '../associations/entities/association.entity';
import { AccountBell } from './entities/account-bell.entity';
import { AccountBellsService } from './account-bells.service';
import { AccountBellsController } from './account-bells.controller';
import { FollowsService } from './follows.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AssociationFollow,
      UserFollow,
      UserFollowNotice,
      AccountBell,
      Association,
    ]),
  ],
  controllers: [AccountBellsController],
  providers: [FollowsService, AccountBellsService],
  exports: [FollowsService, AccountBellsService],
})
export class FollowsModule {}
