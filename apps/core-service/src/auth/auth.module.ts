import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AuthSessionsService } from './auth-sessions.service';
import { AuthSession } from './entities/auth-session.entity';
import { UsersModule } from '../users/users.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [TypeOrmModule.forFeature([AuthSession]), UsersModule, PlatformModule],
  controllers: [AuthController],
  providers: [AuthSessionsService],
  exports: [AuthSessionsService],
})
export class AuthModule {}
