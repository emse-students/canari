import { Module, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { HealthController } from './controllers/health.controller';
import { SyncController } from './controllers/sync.controller';
import { SecurityController } from './controllers/security.controller';
import { GroupsController } from './controllers/groups.controller';
import { MembersController } from './controllers/members.controller';
import { DevicesController } from './controllers/devices.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { LocksController } from './controllers/locks.controller';
import { MessagingController } from './controllers/messaging.controller';
import { MessagingService } from './services/messaging.service';
import { PushController } from './controllers/push.controller';
import { InternalController } from './controllers/internal.controller';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { OneTimeKeyPackage } from './entities/one-time-key-package.entity';
import { GroupMember } from './entities/group-member.entity';
import { Group } from './entities/group.entity';
import { PinVerifier } from './entities/pin-verifier.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { PushToken } from './entities/push-token.entity';
import { RevokedDevice } from './entities/revoked-device.entity';
import Redis from 'ioredis';

const RedisProvider: Provider = {
  provide: 'REDIS_CLIENT',
  useFactory: () => {
    return new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    });
  },
};

/** Root NestJS module: wires PostgreSQL via TypeORM, Redis, and all MLS controllers. */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url:
        process.env.POSTGRES_URL ||
        'postgres://admin:password@localhost:5432/auth_db',
      entities: [
        QueuedMessage,
        KeyPackage,
        OneTimeKeyPackage,
        GroupMember,
        Group,
        PinVerifier,
        DeviceGroupMembership,
        PushToken,
        RevokedDevice,
      ],
      synchronize: true, // TODO : switch to dev only once stable
    }),
    TypeOrmModule.forFeature([
      QueuedMessage,
      KeyPackage,
      OneTimeKeyPackage,
      GroupMember,
      Group,
      PinVerifier,
      DeviceGroupMembership,
      PushToken,
      RevokedDevice,
    ]),
  ],
  controllers: [
    AppController,
    HealthController,
    SyncController,
    SecurityController,
    GroupsController,
    MembersController,
    DevicesController,
    InvitationsController,
    LocksController,
    MessagingController,
    PushController,
    InternalController,
  ],
  providers: [RedisProvider, MessagingService],
})
export class AppModule {}
