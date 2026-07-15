import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { PlatformService, type PlatformConfigPublic } from './platform.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';

/** Global-admin endpoints to read and update platform maintenance / min-version settings. */
@Controller('users/admin/platform')
export class PlatformAdminController {
  constructor(private readonly platformService: PlatformService) {}

  /** Returns current platform settings (maintenance flag, message, min client version). */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get()
  getConfig(): Promise<PlatformConfigPublic> {
    return this.platformService.getConfig();
  }

  /** Updates platform settings; only supplied fields are changed. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Patch()
  updateConfig(@Body() dto: UpdatePlatformConfigDto): Promise<PlatformConfigPublic> {
    return this.platformService.updateConfig(dto);
  }
}
