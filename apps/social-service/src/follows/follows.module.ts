import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AssociationFollow } from './entities/association-follow.entity';
import { UserFollow } from './entities/user-follow.entity';
import { Association } from '../associations/entities/association.entity';
import { FollowsService } from './follows.service';

@Module({
  imports: [TypeOrmModule.forFeature([AssociationFollow, UserFollow, Association])],
  providers: [FollowsService],
  exports: [FollowsService],
})
export class FollowsModule {}
