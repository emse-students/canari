import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { OpenSpaceDto, SetAudiencesDto, SetSpaceBdeDto } from './dto/space.dto';
import { SpacesService } from './spaces.service';

/**
 * The spaces admin API (WP6d). Registered BEFORE `AssociationsController` in the module so its
 * literal `associations/spaces` route wins over `associations/:id`. Every route is global-admin
 * only: opening a space and choosing its BDE are cross-space rights (D24).
 */
@Controller('associations/spaces')
@UseGuards(NginxAuthGuard, GlobalAdminGuard)
export class SpacesController {
  constructor(private readonly service: SpacesService) {}

  /** Lists the open spaces with their BDE. */
  @Get()
  list() {
    return this.service.list();
  }

  /** Opens a space (D17). */
  @Post()
  open(@Body() dto: OpenSpaceDto) {
    return this.service.open(dto.formation, dto.campus);
  }

  /** Designates, or clears with `null`, the BDE of a space (D22). */
  @Put(':id/bde')
  @HttpCode(204)
  async setBde(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetSpaceBdeDto) {
    await this.service.setBde(id, dto.associationId);
  }
}

/** The audience rules of an association (D19): who it addresses. Global-admin only. */
@Controller('associations/:id/audiences')
@UseGuards(NginxAuthGuard, GlobalAdminGuard)
export class AssociationAudiencesController {
  constructor(private readonly service: SpacesService) {}

  /** The rules of one association. */
  @Get()
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.getAudiences(id);
  }

  /** Replaces the rules of one association. */
  @Put()
  set(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAudiencesDto) {
    return this.service.setAudiences(id, dto.rules);
  }
}
