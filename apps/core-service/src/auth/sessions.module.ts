import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuthSessionsService } from './auth-sessions.service';
import { SessionPushEndService } from './session-push-end.service';
import { AuthSession } from './entities/auth-session.entity';

/**
 * The session store and its push-ending outbox, as a module of their own: the auth routes open and
 * end sessions, and the user routes end a person's sessions when a role they carried changes
 * (`UsersController.setAdmin`). `AuthModule` imports `UsersModule`, so the sessions cannot live in
 * `AuthModule` without a cycle; both import this one instead, and it has ONE instance of each
 * service (and so one sweep timer and one outbox drain).
 */
@Module({
  imports: [TypeOrmModule.forFeature([AuthSession])],
  providers: [AuthSessionsService, SessionPushEndService],
  exports: [AuthSessionsService, SessionPushEndService],
})
export class SessionsModule {}
