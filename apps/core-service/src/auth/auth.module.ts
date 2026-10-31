import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { InternalSessionsController } from './internal-sessions.controller';
import { AdminerAccessService } from './adminer-access.service';
import { SessionsModule } from './sessions.module';
import { AuthSession } from './entities/auth-session.entity';
import { RestoreChallengeSpent, RestoreCredential } from './restore/restore-credential.entity';
import { RestoreCredentialsService } from './restore/restore-credentials.service';
import { UsersModule } from '../users/users.module';
import { PlatformModule } from '../platform/platform.module';
import { AccountErasureModule } from '../account-erasure/account-erasure.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuthSession, RestoreCredential, RestoreChallengeSpent]),
    SessionsModule,
    UsersModule,
    PlatformModule,
    AccountErasureModule,
  ],
  controllers: [AuthController, InternalSessionsController],
  providers: [AdminerAccessService, RestoreCredentialsService],
  exports: [SessionsModule],
})
export class AuthModule {}
