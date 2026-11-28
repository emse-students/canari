import { Controller, Get, Headers, Logger, NotFoundException, Param } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { User } from '../users/entities/user.entity';
import { MAIL_CLASSES, type MailClass } from '../users/mail-class';
import { RouteParams } from '../common/route-params';

/** The typed `code` of the 404 for an id with no account row. */
export const MAIL_ACCOUNT_UNKNOWN = 'MAIL_ACCOUNT_UNKNOWN';

/**
 * THE MAIL RELAY'S ELIGIBILITY SOURCE (docs/wiki/mail-client-transport.md#eligibility).
 * chat-gateway admits a relay socket only for an account whose stored mail class is `student` or
 * `staff`. The class is learnt AT SIGN-IN from MiConnect's `school_mail` claim (CAS accounts only,
 * owner 2026-11-27) and kept in `users.mailClass`; this route reads that column and nothing else -
 * no MiConnect call per connection, no address anywhere.
 *
 * WHY A ROUTE AND NOT A CLAIM IN THE ACCESS TOKEN (sessions.md): the access token is minted at
 * every refresh, which never sees MiConnect's claims, so a claim there would be this same column
 * read anyway; and the token rides on every request to every service, while only the relay needs
 * the class - charter principle 1 keeps it where it is used.
 *
 * Answers: 200 `{ mailClass }` (`null` - not offered), 404 {@link MAIL_ACCOUNT_UNKNOWN} when there
 * is no row. A value in the column that is not a known class is answered `null` and accused.
 *
 * NOT reachable through nginx (`/api/internal` has no location), and gated on INTERNAL_SECRET.
 */
@RouteParams({ id: 'opaque' })
@Controller('internal')
export class InternalMailController {
  private readonly logger = new Logger(InternalMailController.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>
  ) {}

  /** The mail class of account `id`, for the mail relay's admission. */
  @Get('users/:id/mail-class')
  async mailClass(
    @Param('id') id: string,
    @Headers('x-internal-secret') secret?: string
  ): Promise<{ mailClass: MailClass | null }> {
    assertInternalSecret(secret);
    const short = id.slice(0, 8);
    const user = await this.userRepo.findOne({
      where: { id },
      select: { id: true, mailClass: true },
    });
    if (!user) {
      this.logger.debug(`internal mail-class id=${short}: no row`);
      throw new NotFoundException({ code: MAIL_ACCOUNT_UNKNOWN, message: 'No such account.' });
    }
    const stored = user.mailClass ?? null;
    const mailClass = stored !== null && MAIL_CLASSES.includes(stored) ? stored : null;
    if (stored !== null && mailClass === null) {
      this.logger.error(
        `internal mail-class id=${short}: stored class ${JSON.stringify(stored)} is not a known class - answered null`
      );
    }
    this.logger.debug(`internal mail-class id=${short}: ${mailClass ?? 'none'}`);
    return { mailClass };
  }
}
