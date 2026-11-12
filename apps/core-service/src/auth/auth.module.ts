import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthController } from './auth.controller';
import { InternalSessionsController } from './internal-sessions.controller';
import { AdminerAccessService } from './adminer-access.service';
import { HandoffService } from './handoff/handoff.service';
import { HANDOFF_ACCESS, MiconnectHandoffAccess } from './handoff/handoff-access';
import { MiconnectReaderClient } from './handoff/miconnect-reader.client';
import { User } from '../users/entities/user.entity';
import { SessionsModule } from './sessions.module';
import { AuthSession } from './entities/auth-session.entity';
import { RestoreChallengeSpent, RestoreCredential } from './restore/restore-credential.entity';
import { RestoreCredentialsService } from './restore/restore-credentials.service';
import { UsersModule } from '../users/users.module';
import { PlatformModule } from '../platform/platform.module';
import { AccountErasureModule } from '../account-erasure/account-erasure.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([AuthSession, RestoreCredential, RestoreChallengeSpent, User]),
    SessionsModule,
    UsersModule,
    PlatformModule,
    AccountErasureModule,
  ],
  controllers: [AuthController, InternalSessionsController],
  providers: [
    AdminerAccessService,
    RestoreCredentialsService,
    HandoffService,
    MiconnectReaderClient,
    MiconnectHandoffAccess,
    { provide: HANDOFF_ACCESS, useExisting: MiconnectHandoffAccess },
  ],
  exports: [SessionsModule],
})
export class AuthModule {}
