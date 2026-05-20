import { Controller, Get } from '@nestjs/common';
import { VersionService, type AppVersionResponse } from './version.service';

/** Public app version endpoint for client update checks. */
@Controller('version')
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  /** Latest deployed app version from core-service package.json. */
  @Get()
  getVersion(): AppVersionResponse {
    return this.versionService.getVersion();
  }
}
