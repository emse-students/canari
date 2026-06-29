import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExternalController } from './external.controller';
import { User } from '../users/entities/user.entity';

/** Public, API-key-protected profile API for trusted external apps (Sky). */
@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [ExternalController],
})
export class ExternalModule {}
