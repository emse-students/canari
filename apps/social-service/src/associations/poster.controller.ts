import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminOrBdeSuperAdminGuard } from './guards/global-admin-or-bde-super-admin.guard';
import { PosterService } from './poster.service';
import {
  CreatePosterProjectDto,
  PosterZoneDto,
  ReorderPosterZonesDto,
  SetPosterEntriesDto,
  UpdatePosterProjectDto,
} from './dto/poster.dto';
import type { CarteCaller } from './poster-scope';

/** The caller as the carte scope reads it (`poster-scope.ts`). */
function caller(userId: string, ga: string | undefined): CarteCaller {
  return { userId, isGlobalAdmin: ga === 'true' };
}

/**
 * The "Carte de la Vie Asso" editor's API: maps, their zones and their switches.
 *
 * THE GUARD IS THE DOOR, THE SERVICE IS THE REACH (owner, 2026-11-08). The guard admits the platform
 * admin and anyone holding MANAGE_ASSO in some BDE; which maps that person then sees is decided per
 * map by `PosterService` - the maps of the spaces their BDE governs, every map for the platform
 * admin - and a map outside that reach answers 404 (`poster-scope.ts`).
 *
 * Registered BEFORE {@link AssociationsController} in the module so its literal routes win over
 * the `/associations/:id` matcher; `spaces` is declared before `:id` for the same reason.
 */
@UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
@Controller('associations/poster')
export class PosterController {
  constructor(private readonly service: PosterService) {}

  /** The maps the caller manages, most-recently-updated first. */
  @Get()
  list(@Headers('x-user-id') userId: string, @Headers('x-global-admin') ga?: string) {
    return this.service.list(caller(userId, ga));
  }

  /** The spaces the caller may create a map for (the creation form's picker). */
  @Get('spaces')
  spaces(@Headers('x-user-id') userId: string, @Headers('x-global-admin') ga?: string) {
    return this.service.listSpaces(caller(userId, ga));
  }

  /** One map: layout, space, zones, switches, and the associations its space offers. */
  @Get(':id')
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.detail(id, caller(userId, ga));
  }

  /** Creates a map for one space the caller manages. */
  @Post()
  create(
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: CreatePosterProjectDto
  ) {
    return this.service.create(dto, caller(userId, ga));
  }

  /** Renames a map, replaces its layout, or attaches a map that has no space. */
  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: UpdatePosterProjectDto
  ) {
    return this.service.update(id, dto, caller(userId, ga));
  }

  /** Permanently deletes a map. */
  @Delete(':id')
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.remove(id, caller(userId, ga));
  }

  /** Adds a zone to the map. */
  @Post(':id/zones')
  createZone(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: PosterZoneDto
  ) {
    return this.service.createZone(id, dto.label, caller(userId, ga));
  }

  /** Persists the order of the map's zones. Declared before `zones/:zoneId`. */
  @Put(':id/zones/order')
  reorderZones(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: ReorderPosterZonesDto
  ) {
    return this.service.reorderZones(id, dto.orderedIds, caller(userId, ga));
  }

  /** Renames a zone of the map. */
  @Patch(':id/zones/:zoneId')
  renameZone(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: PosterZoneDto
  ) {
    return this.service.renameZone(id, zoneId, dto.label, caller(userId, ga));
  }

  /** Deletes a zone of the map; its associations stay, unzoned. */
  @Delete(':id/zones/:zoneId')
  deleteZone(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('zoneId', ParseUUIDPipe) zoneId: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.deleteZone(id, zoneId, caller(userId, ga));
  }

  /** Writes the switch and/or zone of associations on the map. */
  @Put(':id/entries')
  setEntries(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() dto: SetPosterEntriesDto
  ) {
    return this.service.setEntries(id, dto.entries, caller(userId, ga));
  }

  /**
   * Publishes this map to the public showcase, replacing the live map of ITS SPACE only. The body
   * is the normalized geometry document built by the editor (see `published-carte.ts`), not the raw
   * layout - it is re-validated server-side before it can be served anonymously.
   */
  @Post(':id/publish')
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga: string | undefined,
    @Body() payload: unknown
  ) {
    return this.service.publish(id, payload, caller(userId, ga));
  }

  /** Takes this map offline; its space then has no live map. */
  @Post(':id/unpublish')
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-user-id') userId: string,
    @Headers('x-global-admin') ga?: string
  ) {
    return this.service.unpublish(id, caller(userId, ga));
  }
}
