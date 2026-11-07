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
   * The help ids this account has seen, restricted to the CURRENT allowlist, with how long ago each
   * was first recorded. A row whose id a later release retired is kept in the table (it is the
   * account's own history until erasure) but never handed to a client that cannot declare it.
   *
   * THE AGE IS MEASURED HERE, on the server's clock, from the row's own `seen_at` (written once, by
   * the first insert; a repeat is `DO NOTHING`): a client that waits "30 days after the first
   * showing" (the profile-photo reminder) never compares its own clock to an instant it did not
   * write, so a skewed phone clock cannot make the reminder early, late or repeated.
   */
  async seenWithAges(
    userId: string
  ): Promise<{ seen: HelpId[]; ageSeconds: Partial<Record<HelpId, number>> }> {
    const rows = await this.repo.find({
      where: { userId },
      select: { helpId: true, seenAt: true },
    });
    const at = new Map(rows.map((r) => [r.helpId, r.seenAt]));
    const seen = HELP_IDS.filter((id) => at.has(id));
    const now = Date.now();
    const ageSeconds: Partial<Record<HelpId, number>> = {};
    for (const id of seen) {
      const seenAt = at.get(id);
      if (seenAt) ageSeconds[id] = Math.max(0, Math.floor((now - seenAt.getTime()) / 1000));
    }
    this.logger.debug(`[HELP_SEEN] read user=${userId.slice(0, 8)} seen=${seen.length}`);
    return { seen, ageSeconds };
  }

  /** Records that this account has seen `helpId`. The caller has already checked the allowlist. */
  async markSeen(userId: string, helpId: HelpId): Promise<void> {
    await this.repo.createQueryBuilder().insert().values({ userId, helpId }).orIgnore().execute();
    this.logger.debug(`[HELP_SEEN] seen help=${helpId} user=${userId.slice(0, 8)}`);
  }
}
