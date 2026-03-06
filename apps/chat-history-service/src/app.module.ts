import { Module, Provider } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { QueuedMessage, QueuedMessageSchema } from './queued-message.schema';
import { KeyPackage, KeyPackageSchema } from './key-package.schema';
import { WelcomeMessage, WelcomeMessageSchema } from './welcome-message.schema';
import { UserState, UserStateSchema } from './user-state.schema';
import { GroupMember, GroupMemberSchema } from './group-member.schema';
import Redis from 'ioredis';

const RedisProvider: Provider = {
  provide: 'REDIS_CLIENT',
  useFactory: () => {
    return new Redis({
      host: 'localhost',
      port: 6379,
    });
  },
};

@Module({
  imports: [
    MongooseModule.forRoot('mongodb://localhost:27017/chat_db'),
    MongooseModule.forFeature([
        { name: QueuedMessage.name, schema: QueuedMessageSchema },
        { name: KeyPackage.name, schema: KeyPackageSchema },
        { name: WelcomeMessage.name, schema: WelcomeMessageSchema },
        { name: UserState.name, schema: UserStateSchema },
        { name: GroupMember.name, schema: GroupMemberSchema },
    ]),
  ],
  controllers: [AppController],
  providers: [RedisProvider],
})
export class AppModule {}
