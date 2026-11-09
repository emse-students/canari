import { Controller, Get, Logger, UseGuards } from '@nestjs/common';
import { NginxAuthGuard } from '../common/guards/nginx-auth.guard';

/**
 * THE RETIRED GLOBAL CATEGORY LIST, KEPT AS ONE SHIM (owner, 2026-11-08).
 *
 * The zones of a "Carte de la Vie Asso" belong to each map since migration 147
 * (docs/wiki/carte-vie-asso.md, "A carte belongs to one space"), so the platform-wide taxonomy, its
 * manager and the category picker of the association settings are gone. A build older than that
 * still reads this list on the carte hub, in the carte editor and on the profile settings tab; it
 * answers the empty list, so those screens keep loading (every association uncategorised, no
 * picker option) instead of throwing on a 500 from `associations/:id` - which is what the path
 * would hit without this route. The old write routes are simply gone: no current screen offers them.
 *
 * [LEGACY] listed in docs/wiki/legacy-compatibility.md; removed once `minClientVersion` passes the
 * first stable carrying migration 147. Signed-in only, as since 2026-11-02 (anonymous-surface.md).
 */
@Controller('associations/categories')
export class AssociationCategoriesController {
  private readonly logger = new Logger(AssociationCategoriesController.name);

  /** The empty list, to a build older than the per-map zones. */
  @UseGuards(NginxAuthGuard)
  @Get()
  list(): [] {
    this.logger.warn(
      '[LEGACY] GET associations/categories from a build older than the per-map carte zones - answered []'
    );
    return [];
  }
}
