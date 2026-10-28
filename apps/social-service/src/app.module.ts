import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { ChannelsModule } from './channels/channels.module';
import { PostsModule } from './posts/posts.module';
import { FormsModule } from './forms/forms.module';
import { AssociationsModule } from './associations/associations.module';
import { FollowsModule } from './follows/follows.module';
import { FollowRequestsModule } from './follows/follow-requests.module';
import { UserTagModule } from './users/user-tag.module';
import { PurchaseRecordModule } from './users/purchase-record.module';
import { ModerationModule } from './moderation/moderation.module';
import { InternalModule } from './internal/internal.module';
import { PublicModule } from './public/public.module';
import { RedisModule } from './common/redis';
import { createDataSource } from './common/synchronize-prerequisites';
import { MinesweeperModule } from './minesweeper/minesweeper.module';
import { CoorganisationModule } from './coorganisation/coorganisation.module';
import { BookingsModule } from './bookings/bookings.module';
import { LivesModule } from './lives/lives.module';
import { HealthController } from './health.controller';

/** Root NestJS module - wires up TypeORM, config, Redis, and all social feature modules. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    // Guards the public Cercle cotisant-status check (`PublicController`) against API-key brute-forcing.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 20 }]),
    RedisModule,
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: process.env.DB_USERNAME || 'postgres',
        password: (() => {
          const v = process.env.DB_PASSWORD;
          if (!v) throw new Error('DB_PASSWORD is required');
          return v;
        })(),
        database: process.env.DB_DATABASE || 'canari_social',
        url: process.env.DATABASE_URL,
        autoLoadEntities: true,
        synchronize: process.env.NODE_ENV !== 'production',
      }),
      // Creates the extensions an entity's DDL needs before `synchronize` runs (btree_gist for
      // the bookings exclusion); production, unsynchronised, gets them from migration 087.
      dataSourceFactory: (options) => createDataSource(options!),
    }),
    ChannelsModule,
    PostsModule,
    FormsModule,
    AssociationsModule,
    FollowsModule,
    FollowRequestsModule,
    UserTagModule,
    PurchaseRecordModule,
    ModerationModule,
    InternalModule,
    PublicModule,
    MinesweeperModule,
    // Event co-organisation by proposal (D39): registers the `coorganise` kind and the event port.
    CoorganisationModule,
    // Bookings of rooms and slots (docs/wiki/bookings-chantier.md); WP-B1: the data model only.
    BookingsModule,
    // Lives (docs/wiki/services/lives.md), every route behind LIVE_ENABLED: WP-L2 and WP-L3.
    LivesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
