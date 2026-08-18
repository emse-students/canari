import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsersModule } from './users/users.module';
import { AuthModule } from './auth/auth.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health.controller';
import { User } from './users/entities/user.entity';
import { AuthSession } from './auth/entities/auth-session.entity';
import { PlatformConfig } from './platform/entities/platform-config.entity';
import { PlatformAnnouncement } from './platform/entities/platform-announcement.entity';
import { PlatformAnnouncementSeen } from './platform/entities/platform-announcement-seen.entity';
import { PaymentModule } from './payment/payment.module';
import { VersionModule } from './version/version.module';
import { ExternalModule } from './external/external.module';
import { InternalModule } from './internal/internal.module';
import { SkyModule } from './sky/sky.module';

/** Root NestJS module - wires up TypeORM, config, auth, users, payments, and version. */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get<string>('DB_HOST', 'postgres'),
        port: configService.get<number>('DB_PORT', 5432),
        username: configService.get<string>('DB_USERNAME', 'admin'),
        password: configService.getOrThrow<string>('DB_PASSWORD'),
        database: configService.get<string>('DB_DATABASE', 'auth_db'), // Changed from users_db to auth_db globally
        entities: [
          User,
          AuthSession,
          PlatformConfig,
          PlatformAnnouncement,
          PlatformAnnouncementSeen,
        ],
        synchronize: process.env.NODE_ENV !== 'production',
      }),
      inject: [ConfigService],
    }),
    UsersModule,
    AuthModule,
    PaymentModule,
    VersionModule,
    ExternalModule,
    InternalModule,
    SkyModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
