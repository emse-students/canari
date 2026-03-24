import { Module, Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { QueuedMessage } from './entities/queued-message.entity';
import { KeyPackage } from './entities/key-package.entity';
import { WelcomeMessage } from './entities/welcome-message.entity';
import { GroupMember } from './entities/group-member.entity';
import { Group } from './entities/group.entity';
import { PinVerifier } from './entities/pin-verifier.entity';
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
    TypeOrmModule.forRoot({
      type: 'postgres',
      url:
        process.env.POSTGRES_URL ||
        'postgres://admin:password@localhost:5432/auth_db',
      entities: [
        QueuedMessage,
        KeyPackage,
        WelcomeMessage,
        GroupMember,
        Group,
        PinVerifier,
      ],
      synchronize: process.env.NODE_ENV !== 'production',
    }),
    TypeOrmModule.forFeature([
      QueuedMessage,
      KeyPackage,
      WelcomeMessage,
      GroupMember,
      Group,
      PinVerifier,
    ]),
  ],
  controllers: [AppController],
  providers: [RedisProvider],
})
export class AppModule {}
