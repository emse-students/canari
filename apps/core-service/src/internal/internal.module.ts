import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InternalUsersController } from './internal-users.controller';
import { InternalMailController } from './internal-mail.controller';
import { User } from '../users/entities/user.entity';
import { MiconnectReaderClient } from '../auth/handoff/miconnect-reader.client';

/** Server-to-server endpoints, gated on INTERNAL_SECRET and not exposed through nginx. */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [InternalUsersController, InternalMailController],
  // Stateless (it reads its configuration at call time), so this module's own instance is the
  // same reader AuthModule holds for the handoff.
  providers: [MiconnectReaderClient],
})
export class InternalModule {}
