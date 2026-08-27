import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UserBlocksService } from './user-blocks.service';
import { AvatarService } from './avatar.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { UserBlock } from './entities/user-block.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserBlock])],
  providers: [UsersService, AvatarService, UserBlocksService],
  controllers: [UsersController],
  exports: [UsersService, AvatarService, UserBlocksService],
})
export class UsersModule {}
