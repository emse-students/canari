import {
  ConflictException,
  Controller,
  Get,
  Headers,
  Logger,
  NotFoundException,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { assertInternalSecret } from './internal-secret.util';
import { User } from '../users/entities/user.entity';
import { MiconnectReadError, MiconnectReaderClient } from '../auth/handoff/miconnect-reader.client';
import { RouteParams } from '../common/route-params';

/** The typed `code` of the 404 for an account with no MiConnect link (or no row at all). */
export const MAIL_ACCOUNT_UNKNOWN = 'MAIL_ACCOUNT_UNKNOWN';
/** The typed `code` of the 503 when MiConnect could not be read (not configured, unreachable). */
export const MAIL_DOMAIN_UNAVAILABLE = 'MAIL_DOMAIN_UNAVAILABLE';
/** The typed `code` of the 409 when the MiConnect account linked to a row is another person's. */
export const MAIL_IDENTITY_MISMATCH = 'MAIL_IDENTITY_MISMATCH';

/**
 * The domain of an address, lowercased: what follows its LAST `@`, `null` when there is none.
 * Exported for its test; the one place an address is read is {@link InternalMailController}.
 */
export function mailDomainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf('@');
  const domain =
    at >= 0
      ? address
          .slice(at + 1)
          .trim()
          .toLowerCase()
      : '';
  return domain && !domain.includes(' ') ? domain : null;
}

/**
 * THE MAIL RELAY'S ELIGIBILITY SOURCE (docs/wiki/mail-client.md D1, D5;
 * docs/wiki/mail-client-transport.md#eligibility). chat-gateway admits a relay socket only for an
 * account whose MiConnect address is on a school domain, and Canari stores no address: the OIDC
 * sign-in carries none (the email claim is synthetic by design, 10-mappings.yaml). So the question
 * is asked of MiConnect when a relay socket opens, through the READ-ONLY reader account the
 * sign-in handoff already uses (`view_user`), and only the DOMAIN leaves this service.
 *
 * Answers: 200 `{ domain }` (`null` for an inactive account or one with no address), 404
 * {@link MAIL_ACCOUNT_UNKNOWN}, 503 {@link MAIL_DOMAIN_UNAVAILABLE}, 409
 * {@link MAIL_IDENTITY_MISMATCH}. The gateway admits on a listed domain, refuses on a 200 or a 404,
 * and answers 503 on anything else - a question nobody could answer is never "not eligible".
 *
 * NOT reachable through nginx (`/api/internal` has no location), and gated on INTERNAL_SECRET.
 */
@RouteParams({ id: 'opaque' })
@Controller('internal')
export class InternalMailController {
  private readonly logger = new Logger(InternalMailController.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly reader: MiconnectReaderClient
  ) {}

  /** The domain of the MiConnect address of account `id`, for the mail relay's admission. */
  @Get('users/:id/mail-domain')
  async mailDomain(
    @Param('id') id: string,
    @Headers('x-internal-secret') secret?: string
  ): Promise<{ domain: string | null }> {
    assertInternalSecret(secret);
    const short = id.slice(0, 8);
    this.logger.debug(`internal mail-domain asked id=${short}`);
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user?.miconnectUuid) {
      this.logger.debug(
        `internal mail-domain id=${short}: ${user ? 'no MiConnect link' : 'no row'}`
      );
      throw new NotFoundException({ code: MAIL_ACCOUNT_UNKNOWN, message: 'No MiConnect account.' });
    }
    let account;
    try {
      account = await this.reader.findAccount(user.miconnectUuid);
    } catch (err) {
      if (err instanceof MiconnectReadError) {
        this.logger.warn(
          `internal mail-domain id=${short}: MiConnect ${err.failure} (${err.detail}) - 503`
        );
        throw new ServiceUnavailableException({
          code: MAIL_DOMAIN_UNAVAILABLE,
          failure: err.failure,
          message: 'MiConnect could not be read.',
        });
      }
      throw err;
    }
    if (!account) {
      this.logger.debug(`internal mail-domain id=${short}: MiConnect knows no such account`);
      throw new NotFoundException({ code: MAIL_ACCOUNT_UNKNOWN, message: 'No MiConnect account.' });
    }
    if (account.uid !== id) {
      // The uuid link names another person's account: answering for it would hand one person's
      // eligibility to another. A fault to read, never an answer.
      this.logger.error(
        `internal mail-domain id=${short}: the linked MiConnect account's uid is ${account.uid.slice(0, 8)} - 409`
      );
      throw new ConflictException({
        code: MAIL_IDENTITY_MISMATCH,
        message: 'The linked MiConnect account is not this one.',
      });
    }
    const domain = account.isActive ? mailDomainOf(account.email) : null;
    this.logger.debug(
      `internal mail-domain id=${short}: active=${account.isActive} domain=${domain ?? 'none'}`
    );
    return { domain };
  }
}
