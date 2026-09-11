import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { LegacyCotisationAdminPage, LegacyCotisationService } from './legacy-cotisation.service';
import { ListLegacyCotisationsQueryDto } from './dto/legacy-cotisation.dto';

/**
 * Read-only window onto the legacy cotisation staging table.
 *
 * Global admin only, and not per-association: the table spans every estate that was loaded, a
 * collision is only visible by looking across them, and reading it exposes the names of people who
 * have no Canari account at all.
 *
 * Mounted under `associations/` because that is the nginx prefix that reaches this service -
 * `/api/admin/*` is proxied to chat-gateway. The two-segment path collides with no `:id` route.
 */
@Controller('associations/admin/legacy-cotisations')
@UseGuards(NginxAuthGuard, GlobalAdminGuard)
export class LegacyCotisationsAdminController {
  constructor(private readonly legacyCotisations: LegacyCotisationService) {}

  /** Returns one page of staged rows plus the estate-wide pending/claimed/collision tallies. */
  @Get()
  list(@Query() query: ListLegacyCotisationsQueryDto): Promise<LegacyCotisationAdminPage> {
    return this.legacyCotisations.listForAdmin({
      status: query.status,
      search: query.search,
      offset: query.offset,
      limit: query.limit,
    });
  }
}
