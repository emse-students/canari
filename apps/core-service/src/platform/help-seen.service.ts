import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { HelpSeen } from './entities/help-seen.entity';
import { User } from '../users/entities/user.entity';
import { HELP_IDS, type HelpId } from './help-ids';
import {
  PROFILE_PHOTO_PROMPT_SPACES_ENV,
  isPromptEligible,
  parsePromptSpaces,
} from './profile-photo-prompt-spaces';

/**
 * Which first-time helps an account has seen (docs/wiki/frontend/guided-help.md).
 *
 * Both operations are idempotent: a read is a read, and recording a help already recorded is an
 * `INSERT ... ON CONFLICT DO NOTHING` that changes nothing - so the client may send the same id from
 * every device, and again after a lost answer, at no cost.
 */
@Injectable()
export class HelpSeenService implements OnModuleInit {
  private readonly logger = new Logger(HelpSeenService.name);
  /** The profile-photo prompt's eligible spaces, read from the environment once (TEMPORARY). */
  private readonly promptSpaces = parsePromptSpaces(process.env[PROFILE_PHOTO_PROMPT_SPACES_ENV]);

  constructor(
    @InjectRepository(HelpSeen)
    private readonly repo: Repository<HelpSeen>,
    @InjectRepository(User)
    private readonly users: Repository<User>
  ) {}

  /** Says once what the prompt's variable resolved to; a value that does not parse is an error. */
  onModuleInit(): void {
    const { spaces, invalid } = this.promptSpaces;
    if (invalid.length > 0) {
      this.logger.error(
        `[PROFILE_PHOTO_PROMPT] ${PROFILE_PHOTO_PROMPT_SPACES_ENV} does not parse (refused: ${invalid.join(' | ')}) - nobody is prompted; expected FORMATION:campus, comma-separated`
      );
      return;
    }
    this.logger.log(
      `[PROFILE_PHOTO_PROMPT] ${PROFILE_PHOTO_PROMPT_SPACES_ENV} = ${
        spaces.length === 0
          ? '(unset) - nobody is prompted'
          : spaces.map((s) => `${s.formation}:${s.campus}`).join(',')
      }`
    );
  }

  /**
   * Whether this account is offered the profile-photo prompt: its space is one of the variable's.
   * Decided here, from the profile the server holds, so the client never guesses it and widening the
   * set needs no release. TEMPORARY, see `profile-photo-prompt-spaces.ts`.
   */
  async profilePhotoPromptEligible(userId: string): Promise<boolean> {
    if (this.promptSpaces.spaces.length === 0) return false;
    const user = await this.users.findOne({
      where: { id: userId },
      select: { id: true, campus: true, cursus: true },
    });
    return isPromptEligible(user, this.promptSpaces.spaces);
  }

  /**
   * The help ids this account has seen, restricted to the CURRENT allowlist, with how long ago each
   * was first recorded. A row whose id a later release retired is kept in the table (it is the
   * account's own history until erasure) but never handed to a client that cannot declare it.
   *
   * THE AGE IS MEASURED HERE: this application server's `Date.now()` minus the database's `seen_at`
   * (written once, by the first insert; a repeat is `DO NOTHING`) - two server clocks, never a device's: a client that waits "30 days after the first
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
