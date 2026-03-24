import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from './channels/channels.module';
import { PostsModule } from './posts/posts.module';
import { FormsModule } from './forms/forms.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot({
      type: 'postgres',
      url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/canari_social',
      autoLoadEntities: true,
      synchronize: true, // Only for dev
    }),
    ChannelsModule,
    PostsModule,
    FormsModule,
  ],
  controllers: [],
})
export class AppModule {}
