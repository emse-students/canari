import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { AdminerAccessService } from './adminer-access.service';
import { AuthSessionsService } from './auth-sessions.service';
import { SessionPushEndService } from './session-push-end.service';
import { AuthSession } from './entities/auth-session.entity';
import { UsersModule } from '../users/users.module';
import { PlatformModule } from '../platform/platform.module';
import { AccountErasureModule } from '../account-erasure/account-erasure.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuthSession]),
    UsersModule,
    PlatformModule,
    AccountErasureModule,
  ],
  controllers: [AuthController],
  providers: [AuthSessionsService, SessionPushEndService, AdminerAccessService],
  exports: [AuthSessionsService],
})
export class AuthModule {}
