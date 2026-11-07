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
import { SetAudiencesDto, SetDependencyDto, SetSpaceBdeDto } from './dto/space.dto';
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

  /**
   * The audience rules of every association, for the admin grid of OLDER builds: the current one
   * reads each page's rules with `GET associations/admin/catalogue`. A shim, retired with the floor
   * (docs/wiki/legacy-compatibility.md).
   */
  @Get('audiences')
  listAudiences() {
    return this.service.listAudiences();
  }

  /**
   * Designates, or clears with `null`, the governor of a space (D22): a BDE or an institution
   * (reform 2.3), journaled with the admin who did it (2.7).
   */
  @Put(':id/bde')
  @HttpCode(204)
  async setBde(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: SetSpaceBdeDto
  ) {
    await this.service.setBde(id, dto.associationId, { userId });
  }

  /** Every entity with its governing parent, its label and its mismatches (the Dependencies panel). */
  @Get('dependencies')
  dependencies() {
    return this.service.listDependencies();
  }

  /**
   * Sets the governing parent (and optionally the G3 label) of an association or a list (reform
   * 2.7): platform admin only, journaled. A refusal is a typed 409 (`spaces/dependency-rules.ts`).
   */
  @Put('dependencies/:associationId')
  @HttpCode(204)
  async setDependency(
    @Param('associationId', ParseUUIDPipe) associationId: string,
    @Headers('x-user-id') userId: string,
    @Body() dto: SetDependencyDto
  ) {
    await this.service.setParent(
      associationId,
      dto.parentAssociationId,
      { userId },
      dto.displayParentAssociationId
    );
  }
}

/**
 * The audience rules of an association (D19): who it addresses. Reading and writing are a global
 * admin's OR a BDE star's (MANAGE_ASSO) inside its own campus - the policy is enforced in
 * `SpacesService.getAudiencesFor` / `setAudiences`, which need the caller, so the guard is not
 * class-wide.
 */
@Controller('associations/:id/audiences')
@UseGuards(NginxAuthGuard)
export class AssociationAudiencesController {
  constructor(private readonly service: SpacesService) {}

  /** The rules of one association (global admin, or a BDE star within its campus). */
  @Get()
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined
  ) {
    return this.service.getAudiencesFor(id, { userId, isGlobalAdmin: ga === 'true' });
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
