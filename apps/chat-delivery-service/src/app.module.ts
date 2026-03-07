import { Module, Provider } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { QueuedMessage, QueuedMessageSchema } from './queued-message.schema';
import { KeyPackage, KeyPackageSchema } from './key-package.schema';
import { WelcomeMessage, WelcomeMessageSchema } from './welcome-message.schema';
import { UserState, UserStateSchema } from './user-state.schema';
import { GroupMember, GroupMemberSchema } from './group-member.schema';
import { Group, GroupSchema } from './group.schema';
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

@Module({
  imports: [
    MongooseModule.forRoot(
      process.env.MONGO_URI || 'mongodb://localhost:27017/chat_db',
    ),
    MongooseModule.forFeature([
      { name: QueuedMessage.name, schema: QueuedMessageSchema },
      { name: KeyPackage.name, schema: KeyPackageSchema },
      { name: WelcomeMessage.name, schema: WelcomeMessageSchema },
      { name: UserState.name, schema: UserStateSchema },
      { name: GroupMember.name, schema: GroupMemberSchema },
      { name: Group.name, schema: GroupSchema },
    ]),
  ],
  controllers: [AppController],
  providers: [RedisProvider],
})
export class AppModule {}
