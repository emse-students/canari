import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from './channels/channels.module';
import { PostsModule } from './posts/posts.module';
import { FormsModule } from './forms/forms.module';
import { AssociationsModule } from './associations/associations.module';
import { FollowsModule } from './follows/follows.module';
import { RedisModule } from './common/redis';

/** Root NestJS module — wires up TypeORM, config, Redis, and all social feature modules. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    TypeOrmModule.forRootAsync({
      useFactory: () => ({
        type: 'postgres',
        host: process.env.DB_HOST || 'localhost',
        port: parseInt(process.env.DB_PORT || '5432', 10),
        username: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_DATABASE || 'canari_social',
        url: process.env.DATABASE_URL,
        autoLoadEntities: true,
        synchronize: true, // TODO : switch to dev only once stable
      }),
    }),
    ChannelsModule,
    PostsModule,
    FormsModule,
    AssociationsModule,
    FollowsModule,
  ],
  controllers: [],
})
export class AppModule {}
