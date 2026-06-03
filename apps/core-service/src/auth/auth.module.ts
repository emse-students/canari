import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { PlatformModule } from '../platform/platform.module';

@Module({
  imports: [UsersModule, PlatformModule],
  controllers: [AuthController],
})
export class AuthModule {}
