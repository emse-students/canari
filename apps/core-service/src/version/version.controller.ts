import { Controller, Get } from '@nestjs/common';
import { VersionService, type AppVersionResponse } from './version.service';

/** Public app version endpoint for client update checks. */
@Controller('version')
export class VersionController {
  constructor(private readonly versionService: VersionService) {}

  /** Latest deployed app version and platform gates (maintenance, min client version). */
  @Get()
  getVersion(): Promise<AppVersionResponse> {
    return this.versionService.getVersion();
  }
}
