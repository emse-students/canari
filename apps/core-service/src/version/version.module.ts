import { Module } from '@nestjs/common';
import { VersionController } from './version.controller';
import { VersionService } from './version.service';

/** Public app version endpoint (`GET /api/version`). */
@Module({
  controllers: [VersionController],
  providers: [VersionService],
})
export class VersionModule {}
