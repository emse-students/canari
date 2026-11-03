import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HelpSeen } from './entities/help-seen.entity';
import { HELP_IDS, type HelpId } from './help-ids';

/**
 * Which first-time helps an account has seen (docs/wiki/frontend/guided-help.md).
 *
 * Both operations are idempotent: a read is a read, and recording a help already recorded is an
 * `INSERT ... ON CONFLICT DO NOTHING` that changes nothing - so the client may send the same id from
 * every device, and again after a lost answer, at no cost.
 */
@Injectable()
export class HelpSeenService {
  private readonly logger = new Logger(HelpSeenService.name);

  constructor(
    @InjectRepository(HelpSeen)
    private readonly repo: Repository<HelpSeen>
  ) {}

  /**
   * The help ids this account has seen, restricted to the CURRENT allowlist: a row whose id a later
   * release retired is kept in the table (it is the account's own history until erasure) but never
   * handed to a client that cannot declare it.
   */
  async seenBy(userId: string): Promise<HelpId[]> {
    const rows = await this.repo.find({ where: { userId }, select: { helpId: true } });
    const known = new Set(rows.map((r) => r.helpId));
    const seen = HELP_IDS.filter((id) => known.has(id));
    this.logger.debug(`[HELP_SEEN] read user=${userId.slice(0, 8)} seen=${seen.length}`);
    return seen;
  }

  /** Records that this account has seen `helpId`. The caller has already checked the allowlist. */
  async markSeen(userId: string, helpId: HelpId): Promise<void> {
    await this.repo.createQueryBuilder().insert().values({ userId, helpId }).orIgnore().execute();
    this.logger.debug(`[HELP_SEEN] seen help=${helpId} user=${userId.slice(0, 8)}`);
  }
}
