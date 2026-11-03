import { Body, Controller, Get, Headers, Logger, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { UserResourceThrottlerGuard } from '../common/guards/user-resource-throttler.guard';
import { toAssociationView } from './association.projection';
import { AssociationsService } from './associations.service';
import {
  AdminCatalogueQueryDto,
  AdminCreateAssociationDto,
  AdminSlugPreviewQueryDto,
} from './dto/admin-association.dto';

/**
 * Creates an admin may make per minute. A burst of a dozen entities set up in a row stays far
 * below; a loop - a stuck form, a script - is stopped. No route here names a resource, so the
 * bucket of `UserResourceThrottlerGuard` is the caller alone.
 */
export const ADMIN_CREATES_PER_MINUTE = 20;

/** Catalogue pages and slug previews per minute: a search typed fast, paged, stays below. */
export const ADMIN_READS_PER_MINUTE = 120;

/**
 * THE PLATFORM ADMINISTRATOR'S ENTITY ROUTES (`/admin/spaces`, owner 2026-11-02): every association,
 * list and institution, member or not, and creating one placed in its spaces. Registered BEFORE
 * `AssociationsController` so the literal `associations/admin` wins over `associations/:id`. Every
 * route is platform-admin only - a BDE's `MANAGE_ASSO` creates through `POST /associations`, in
 * its own campus, and is refused here (docs/wiki/association-permissions.md).
 */
@Controller('associations/admin')
@UseGuards(NginxAuthGuard, GlobalAdminGuard, UserResourceThrottlerGuard)
export class AdminAssociationsController {
  private readonly logger = new Logger(AdminAssociationsController.name);

  constructor(private readonly service: AssociationsService) {}

  /** One keyset page of one kind, with each row's member count and audience rules. */
  @Get('catalogue')
  @Throttle({ default: { limit: ADMIN_READS_PER_MINUTE, ttl: 60_000 } })
  async catalogue(@Query() query: AdminCatalogueQueryDto) {
    const page = await this.service.adminCatalogue(query);
    return {
      rows: page.rows.map((row) => ({ ...toAssociationView(row), audiences: row.audiences })),
      next: page.next,
    };
  }

  /** The slug a create of `name` would take now; `null` when no candidate is free. */
  @Get('slug-preview')
  @Throttle({ default: { limit: ADMIN_READS_PER_MINUTE, ttl: 60_000 } })
  async slugPreview(@Query() query: AdminSlugPreviewQueryDto) {
    return { slug: await this.service.previewDerivedSlug(query.name) };
  }

  /**
   * Creates an association, a list or an institution in the spaces chosen, with no member unless a
   * first admin is picked - through the ONE creation function, `AssociationsService.create`.
   */
  @Post()
  @Throttle({ default: { limit: ADMIN_CREATES_PER_MINUTE, ttl: 60_000 } })
  async create(@Headers('x-user-id') userId: string, @Body() dto: AdminCreateAssociationDto) {
    this.logger.log(
      `[create] platform admin ${userId.slice(0, 8)} creates a ${dto.type}: ${dto.audiences.length} rule(s), first admin ${dto.firstAdmin ? 'yes' : 'no'}`
    );
    const created = await this.service.create({ name: dto.name, type: dto.type }, userId, true, {
      audiences: dto.audiences,
      firstAdmin: dto.firstAdmin,
    });
    return toAssociationView(created);
  }
}
