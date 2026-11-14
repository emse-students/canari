import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import {
  PlatformService,
  type PlatformConfigPublic,
  type WithheldReleaseResult,
} from './platform.service';
import { UpdatePlatformConfigDto } from './dto/update-platform-config.dto';
import { PublishAnnouncementDto } from './dto/publish-announcement.dto';
import { AnnouncementService, type AnnouncementForAdmin } from './announcement.service';
import { LydiaContractService, type LydiaContractCounter } from './lydia-contract.service';
import type { LydiaContractSettings } from './lydia-contract';

/** Global-admin endpoints to read and update platform maintenance / min-version settings. */
@Controller('users/admin/platform')
export class PlatformAdminController {
  constructor(
    private readonly platformService: PlatformService,
    private readonly announcements: AnnouncementService,
    private readonly lydiaContract: LydiaContractService
  ) {}

  /** The platform's Lydia contract terms (docs/wiki/lydia-contract-flux.md). Confidential: admins only. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get('lydia-contract')
  getLydiaContract(): Promise<LydiaContractSettings> {
    return this.lydiaContract.getSettings();
  }

  /**
   * Replaces the Lydia contract terms with the whole set sent - parsed by hand
   * (`parseLydiaContractTerms`), a 400 `LYDIA_CONTRACT_INVALID` naming the field writing nothing.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Put('lydia-contract')
  putLydiaContract(
    @Headers('x-user-id') xUserId: string,
    @Body() body: unknown
  ): Promise<LydiaContractSettings> {
    return this.lydiaContract.putSettings(body, xUserId.trim().toLowerCase());
  }

  /** The counter of the current contract year: flux against the target, days left, the band. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get('lydia-contract/counter')
  getLydiaContractCounter(): Promise<LydiaContractCounter> {
    return this.lydiaContract.counter();
  }

  /** Returns current platform settings (maintenance flag, message, min client version). */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Get()
  getConfig(): Promise<PlatformConfigPublic> {
    return this.platformService.getConfig();
  }

  /** Updates platform settings; only supplied fields are changed. The actor is logged on a switch. */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Patch()
  updateConfig(
    @Headers('x-user-id') xUserId: string,
    @Body() dto: UpdatePlatformConfigDto
  ): Promise<PlatformConfigPublic> {
    return this.platformService.updateConfig(dto, xUserId.trim().toLowerCase());
  }

  /**
   * Releases the boutique products withheld while payments were disabled - the explicit, idempotent
   * retry for a release that failed after the provider was saved (answered there as
   * `WITHHELD_RELEASE_INCOMPLETE`), so recovery never depends on the settings form's diff.
   */
  @UseGuards(NginxAuthGuard, GlobalAdminGuard)
  @Post('release-withheld-products')
  @HttpCode(200)
  releaseWithheldProducts(@Headers('x-user-id') xUserId: string): Promise<WithheldReleaseResult> {
    return this.platformService.releaseWithheldProducts(xUserId.trim().toLowerCase());
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
