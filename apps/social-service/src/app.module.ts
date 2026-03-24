import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ChannelsModule } from './channels/channels.module';
import { PostsModule } from './posts/posts.module';
import { FormsModule } from './forms/forms.module';

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.SOCIAL_MONGO_URI || 'mongodb://localhost:27017/social_db'
    ),
    ChannelsModule,
    PostsModule,
    FormsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
