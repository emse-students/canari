import { Controller, Get, Headers, Logger, NotFoundException, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { User } from '../users/entities/user.entity';

/** The minimum a `/profile/:id` share needs to render a preview, and nothing else. */
export interface InternalPublicProfile {
  id: string;
  displayName: string | null;
  promo: number | null;
  formation: string | null;
}

/**
 * Session-free display-name lookup, called by the web SSR process when it renders the Open Graph
 * head of `/profile/:id`.
 *
 * `GET /api/users/:id` is behind `NginxAuthGuard` and returns the whole user row; an unfurler has
 * no session, and the head needs a name, a promo and nothing more. Deliberately narrower than
 * `/api/external/profile/:sub`, which aggregates the bio and the association history for Sky and
 * is keyed on a different credential (`EXTERNAL_API_KEY`) - handing that key to the renderer would
 * widen its reach for no gain.
 *
 * NOT reachable through nginx: `/api/internal` has no location, so this is Docker-network only,
 * and gated on INTERNAL_SECRET on top of that.
 */
@Controller('internal')
export class InternalUsersController {
  private readonly logger = new Logger(InternalUsersController.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>
  ) {}

  /**
   * Distinct non-null `formation` values in use, with how many users carry each.
   *
   * Called by social-service to populate a form's "filtrer par formation" picker. It offers what
   * EXISTS rather than a hard-coded list, because `formation` comes from Authentik and the next
   * value arrives with no deploy - prod holds ICM, ISMIN and Master today (measured 2026-08-23),
   * and an enum in code would silently stop matching the fourth. The counts are there so a manager
   * can see a criterion reaches 3 people before building a price around it.
   *
   * Aggregate only: no id, no name, nothing about any individual.
   */
  @Get('users/formations')
  async formations(
    @Headers('x-internal-secret') secret?: string
  ): Promise<{ value: string; count: number }[]> {
    assertInternalSecret(secret);
    const rows: { value: string; count: string }[] = await this.userRepo
      .createQueryBuilder('u')
      .select('u.formation', 'value')
      .addSelect('COUNT(*)', 'count')
      .where('u.formation IS NOT NULL')
      .andWhere("u.formation <> ''")
      .groupBy('u.formation')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany();
    this.logger.debug(`internal formations listing rows=${rows.length}`);
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  /** Display identity for a user id, for the shared-link preview. */
  @Get('users/:id/public-profile')
  async publicProfile(
    @Param('id') id: string,
    @Headers('x-internal-secret') secret?: string
  ): Promise<InternalPublicProfile> {
    assertInternalSecret(secret);
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) {
      this.logger.debug(`internal public-profile miss id=${id.slice(0, 8)}`);
      throw new NotFoundException();
    }
    return {
      id: user.id,
      displayName: user.displayName ?? null,
      promo: user.promo ?? null,
      formation: user.formation ?? null,
    };
  }
}
