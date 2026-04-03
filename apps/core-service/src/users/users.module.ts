import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersService } from './users.service';
import { AvatarService } from './avatar.service';
import { UsersController } from './users.controller';
import { User } from './entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  providers: [UsersService, AvatarService],
  controllers: [UsersController],
  exports: [UsersService, AvatarService],
})
export class UsersModule {}
