import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { UserBlocksService } from './user-blocks.service';
import { AvatarService } from './avatar.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';
import { UserBlock } from './entities/user-block.entity';
import { ProfileChange } from './entities/profile-change.entity';
import { ProfileEditService } from './profile-edit.service';
import { MiconnectEditorClient } from './miconnect-editor.client';

@Module({
  imports: [TypeOrmModule.forFeature([User, UserBlock, ProfileChange])],
  providers: [
    UsersService,
    AvatarService,
    UserBlocksService,
    MiconnectEditorClient,
    ProfileEditService,
  ],
  controllers: [UsersController],
  exports: [UsersService, AvatarService, UserBlocksService, ProfileEditService],
})
export class UsersModule {}
