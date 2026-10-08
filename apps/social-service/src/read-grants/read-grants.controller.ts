import { Body, Controller, Get, Headers, HttpCode, Put, UseGuards } from '@nestjs/common';
import { GlobalAdminGuard } from '../common/guards/global-admin.guard';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';
import { SetReadGrantDto } from './read-grants.dto';
import { ReadGrantsService } from './read-grants.service';

/**
 * The nominative read grants API (WP7). GLOBAL ADMIN ONLY, every route: a grant crosses spaces
 * (D24), and the list of named readers is internal - students are not told, so no non-admin route
 * reads it, not even for the grantee's own row. Registered BEFORE `AssociationsController`, whose
 * `associations/:id` would otherwise take the literal `read-grants`.
 */
@Controller('associations/read-grants')
@UseGuards(NginxAuthGuard, GlobalAdminGuard)
export class ReadGrantsController {
  constructor(private readonly service: ReadGrantsService) {}

  /** Current grants and the journal of grants and revocations. */
  @Get()
  list() {
    return this.service.list();
  }

  /** Grants or revokes one (account x campus x formation) cell. Idempotent. */
  @Put()
  @HttpCode(204)
  async set(@Headers('x-user-id') actor: string, @Body() dto: SetReadGrantDto) {
    await this.service.setCell(
      actor,
      dto.userId.trim(),
      dto.campus,
      dto.formation ?? null,
      dto.granted
    );
  }
}
