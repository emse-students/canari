import { Module } from '@nestjs/common';
import { VersionController } from './version.controller';
import { VersionService } from './version.service';
import { PlatformModule } from '../platform/platform.module';

/** Public app version endpoint (`GET /api/version`). */
@Module({
  imports: [PlatformModule],
  controllers: [VersionController],
  providers: [VersionService],
})
export class VersionModule {}
