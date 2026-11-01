import { Inject, Injectable, Module, OnModuleDestroy, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { HealthController } from './controllers/health.controller';
import { SecurityController } from './controllers/security.controller';
import { GifSearchController } from './controllers/gif-search.controller';
import { GifMediaController } from './controllers/gif-media.controller';
import { GroupsController } from './controllers/groups.controller';
import { MembersController } from './controllers/members.controller';
import { DevicesController } from './controllers/devices.controller';
import { InvitationsController } from './controllers/invitations.controller';
import { LocksController } from './controllers/locks.controller';
import { MessagingController } from './controllers/messaging.controller';
import { MessagingService } from './services/messaging.service';
import { DeviceSignatureKeysService } from './services/device-signature-keys.service';
import { CallsService } from './services/calls.service';
import { ApnsVoipService } from './services/apns-voip.service';
import { TurnUsageMeter } from './services/turn-usage-meter.service';
import { CallsController } from './controllers/calls.controller';
import { PushController } from './controllers/push.controller';
import { InternalController } from './controllers/internal.controller';
import { AdminStorageController } from './controllers/admin-storage.controller';
import { QueuedMessage } from './entities/queued-message.entity';
import { QueuedPayload } from './entities/queued-payload.entity';
import { KeyPackage } from './entities/key-package.entity';
import { OneTimeKeyPackage } from './entities/one-time-key-package.entity';
import { GroupMember } from './entities/group-member.entity';
import { UserDismissedGroup } from './entities/user-dismissed-group.entity';
import { Group } from './entities/group.entity';
import { PinVerifier } from './entities/pin-verifier.entity';
import { DeviceGroupMembership } from './entities/device-group-membership.entity';
import { GroupInvite } from './entities/group-invite.entity';
import { DeviceSignatureKey } from './entities/device-signature-key.entity';
import { PushToken } from './entities/push-token.entity';
import { NotificationPreference } from './entities/notification-preference.entity';
import { NotificationPreferencesController } from './controllers/notification-preferences.controller';
import { RevokedDevice } from './entities/revoked-device.entity';
import { MlsCommitLog } from './entities/mls-commit-log.entity';
import { MlsGroupInfo } from './entities/mls-group-info.entity';
import { GroupMembershipInterval } from './entities/group-membership-interval.entity';
import { SeatEviction } from './entities/seat-eviction.entity';
import { JoinAskPush } from './entities/join-ask-push.entity';
import { RevokedDeviceGroup } from './entities/revoked-device-group.entity';
import Redis from 'ioredis';
import { typeormSynchronize } from './typeorm-synchronize';

const RedisProvider: Provider = {
  provide: 'REDIS_CLIENT',
  useFactory: () => {
    return new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
    });
  },
};

/**
 * Closes the Redis connection when the application shuts down.
 *
 * `RedisProvider` hands back a raw `ioredis` client, and a raw client cannot carry a Nest lifecycle
 * hook - so nothing ever called `quit()` and `app.close()` left the socket open. In a container
 * being killed that goes unnoticed; it stopped being invisible the day a test booted the real
 * `AppModule` and jest would not exit, because an open handle is an open handle whether or not
 * anything is watching. A separate one-purpose provider is deliberate: wrapping the client in a
 * service class would change the injection type at every one of its call sites, to fix a shutdown.
 */
@Injectable()
class RedisShutdown implements OnModuleDestroy {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    // `quit` waits for pending replies, unlike `disconnect`, which drops them. Shutting down is not
    // a reason to lose a command that was already accepted.
    await this.redis.quit();
  }
}

/** Root NestJS module: wires PostgreSQL via TypeORM, Redis, and all MLS controllers. */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10 }]),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: (() => {
        const v = process.env.POSTGRES_URL;
        if (!v) throw new Error('POSTGRES_URL is required');
        return v;
      })(),
      entities: [
        QueuedMessage,
        QueuedPayload,
        KeyPackage,
        OneTimeKeyPackage,
        GroupMember,
        UserDismissedGroup,
        Group,
        PinVerifier,
        DeviceGroupMembership,
        PushToken,
        RevokedDevice,
        GroupInvite,
        MlsCommitLog,
        MlsGroupInfo,
        DeviceSignatureKey,
        NotificationPreference,
        GroupMembershipInterval,
        SeatEviction,
        JoinAskPush,
        RevokedDeviceGroup,
      ],
      synchronize: typeormSynchronize(),
    }),
    TypeOrmModule.forFeature([
      QueuedMessage,
      QueuedPayload,
      KeyPackage,
      OneTimeKeyPackage,
      GroupMember,
      UserDismissedGroup,
      Group,
      PinVerifier,
      DeviceGroupMembership,
      PushToken,
      RevokedDevice,
      GroupInvite,
      MlsCommitLog,
      MlsGroupInfo,
      DeviceSignatureKey,
      NotificationPreference,
      GroupMembershipInterval,
      RevokedDeviceGroup,
    ]),
  ],
  controllers: [
    AppController,
    HealthController,
    SecurityController,
    GifSearchController,
    GifMediaController,
    GroupsController,
    MembersController,
    DevicesController,
    InvitationsController,
    LocksController,
    MessagingController,
    PushController,
    NotificationPreferencesController,
    InternalController,
    AdminStorageController,
    CallsController,
  ],
  providers: [
    RedisProvider,
    RedisShutdown,
    MessagingService,
    DeviceSignatureKeysService,
    CallsService,
    ApnsVoipService,
    TurnUsageMeter,
  ],
})
export class AppModule {}
