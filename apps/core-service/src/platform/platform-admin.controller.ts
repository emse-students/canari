import { Body, Controller, Delete, Get, Headers, Patch, Put, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { PlatformService, type PlatformConfigPublic } from './platform.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { PublishAnnouncementDto } from './dto/publish-announcement.dto';
import { AnnouncementService, type AnnouncementForAdmin } from './announcement.service';

/** Global-admin endpoints to read and update platform maintenance / min-version settings. */
@Controller('users/admin/platform')
export class PlatformAdminController {
  constructor(
    private readonly platformService: PlatformService,
    private readonly announcements: AnnouncementService
  ) {}

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

  /** The announcement being shown right now and how many accounts have seen it, or `null`. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  /**
   * Wrapped for the same reason the member route is: a bare `null` is an EMPTY body, and the panel
   * cannot tell "nothing published" from a response it failed to read.
   */
  @Get('announcement')
  async getAnnouncement(): Promise<{ announcement: AnnouncementForAdmin | null }> {
    return { announcement: await this.announcements.getActiveForAdmin() };
  }

  /**
   * Publishes an announcement, retiring whatever was active. `PUT` rather than `POST` because there
   * is one active announcement at a time: this replaces it rather than adding to a list.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Put('announcement')
  publishAnnouncement(
    @Headers('x-user-id') xUserId: string,
    @Body() dto: PublishAnnouncementDto
  ): Promise<AnnouncementForAdmin> {
    return this.announcements.publish(dto, xUserId.trim().toLowerCase());
  }

  /** Retires the active announcement. Its row and its "seen" rows are kept as the record. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Delete('announcement')
  async retireAnnouncement(@Headers('x-user-id') xUserId: string): Promise<{ success: true }> {
    await this.announcements.retire(xUserId.trim().toLowerCase());
    return { success: true };
  }
}
