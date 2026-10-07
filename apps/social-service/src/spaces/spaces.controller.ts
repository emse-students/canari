import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Put,
  UseGuards,
} from '@nestjs/common';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { SetAudiencesDto, SetSpaceBdeDto } from './dto/space.dto';
import { SpacesService } from './spaces.service';

/**
 * The spaces admin API (WP6d). Registered BEFORE `AssociationsController` in the module so its
 * literal `associations/spaces` route wins over `associations/:id`. Every route is global-admin
 * only: choosing a BDE is a cross-space right (D24).
 */
@Controller('associations/spaces')
@UseGuards(NginxAuthGuard, GlobalAdminGuard)
export class SpacesController {
  constructor(private readonly service: SpacesService) {}

  /** Lists every space with its BDE. */
  @Get()
  list() {
    return this.service.list();
  }

  /** The audience rules of every association, for the admin grid. */
  @Get('audiences')
  listAudiences() {
    return this.service.listAudiences();
  }

  /** Designates, or clears with `null`, the BDE of a space (D22). */
  @Put(':id/bde')
  @HttpCode(204)
  async setBde(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSpaceBdeDto) {
    await this.service.setBde(id, dto.associationId);
  }
}

/**
 * The audience rules of an association (D19): who it addresses. Reading is global-admin only;
 * writing is a global admin's OR a BDE star's (MANAGE_ASSO) inside its own campus - the policy is
 * enforced in `SpacesService.setAudiences`, which needs the caller, so the guard is not class-wide.
 */
@Controller('associations/:id/audiences')
@UseGuards(NginxAuthGuard)
export class AssociationAudiencesController {
  constructor(private readonly service: SpacesService) {}

  /** The rules of one association. */
  @Get()
  @UseGuards(GlobalAdminGuard)
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getAudiences(id);
  }

  /** Replaces the rules of one association (global admin, or a BDE star within its campus). */
  @Put()
  set(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: SetAudiencesDto
  ) {
    return this.service.setAudiences(id, dto.rules, { userId, isGlobalAdmin: ga === 'true' });
  }
}
