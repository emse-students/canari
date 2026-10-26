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
import { ProfileCorrectionService } from './profile-correction.service';
import { ProfileCorrectionRequest } from './entities/profile-correction-request.entity';
import { MiconnectEditorClient } from './miconnect-editor.client';
import { AccountErasureModule } from '../account-erasure/account-erasure.module';
import { SessionsModule } from '../auth/sessions.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, UserBlock, ProfileChange, ProfileCorrectionRequest]),
    AccountErasureModule,
    SessionsModule,
  ],
  providers: [
    UsersService,
    AvatarService,
    UserBlocksService,
    MiconnectEditorClient,
    ProfileEditService,
    ProfileCorrectionService,
  ],
  controllers: [UsersController],
  exports: [UsersService, AvatarService, UserBlocksService, ProfileEditService],
})
export class UsersModule {}
