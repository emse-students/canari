import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalUsersController } from './internal-users.controller';
import { InternalMailController } from './internal-mail.controller';
import { User } from '../users/entities/user.entity';

/** Server-to-server endpoints, gated on INTERNAL_SECRET and not exposed through nginx. */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [InternalUsersController, InternalMailController],
})
export class InternalModule {}
