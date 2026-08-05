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
