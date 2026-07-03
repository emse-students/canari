import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ScheduleModule } from '@nestjs/schedule';
import { ChannelsModule } from './channels/channels.module';
import { PostsModule } from './posts/posts.module';
import { FormsModule } from './forms/forms.module';
import { AssociationsModule } from './associations/associations.module';
import { FollowsModule } from './follows/follows.module';
import { UserTagModule } from './users/user-tag.module';
import { PurchaseRecordModule } from './users/purchase-record.module';
import { ModerationModule } from './moderation/moderation.module';
import { InternalModule } from './internal/internal.module';
import { PublicModule } from './public/public.module';
import { RedisModule } from './common/redis';

/** Root NestJS module - wires up TypeORM, config, Redis, and all social feature modules. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
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
    }),
    ChannelsModule,
    PostsModule,
    FormsModule,
    AssociationsModule,
    FollowsModule,
    UserTagModule,
    PurchaseRecordModule,
    ModerationModule,
    InternalModule,
    PublicModule,
  ],
  controllers: [],
})
export class AppModule {}
