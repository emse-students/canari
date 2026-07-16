import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminOrBdeSuperAdminGuard } from './guards/global-admin-or-bde-super-admin.guard';
import { PosterService } from './poster.service';
import { CreatePosterProjectDto, UpdatePosterProjectDto } from './dto/poster.dto';

/**
 * CRUD for "Carte de la Vie Asso" poster layouts. Every route is restricted to global admins
 * and BDE super-admins.
 *
 * Registered BEFORE {@link AssociationsController} in the module so its literal routes win over
 * the `/associations/:id` matcher.
 */
@UseGuards(NginxAuthGuard, GlobalAdminOrBdeSuperAdminGuard)
@Controller('associations/poster')
export class PosterController {
  constructor(private readonly service: PosterService) {}

  /** Lists all poster projects, most-recently-updated first. */
  @Get()
  list() {
    return this.service.list();
  }

  /** Loads one poster project (full layout). */
  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  /** Creates a poster project owned by the caller. */
  @Post()
  create(@Headers('x-user-id') userId: string, @Body() dto: CreatePosterProjectDto) {
    return this.service.create(dto, userId);
  }

  /** Renames a project and/or replaces its layout. */
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePosterProjectDto) {
    return this.service.update(id, dto);
  }

  /** Permanently deletes a project. */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
