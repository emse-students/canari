import { Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { Submission } from './entities/submission.entity';

const logger = new Logger('FormRequestAccount');

/**
 * The Lydia Business an answer's CURRENT request was issued to (`submissions."lydiaVendorToken"`,
 * written with the request ids, migration 120), or null when the row records none.
 *
 * Every read, cancel and callback check of an issued request uses THIS account, never the form's
 * payee resolved now: a list's delegation may be revoked or moved to another receiver while the
 * request is in flight, and the money still lands on the Business that issued it (owner review of
 * #2967, as `product_checkouts."vendorToken"` does for the shop). A null answer is not replaced by
 * the current payee: a row with request ids and no account predates migration 120, and reading it
 * with another Business's key would be refused by Lydia anyway - the caller says so and stops.
 */
export async function requestAccountOf(
  submissions: Repository<Submission>,
  submissionId: string,
  what: string
): Promise<string | null> {
  const row = await submissions.findOne({
    where: { id: submissionId },
    select: { id: true, lydiaVendorToken: true },
  });
  const account = row?.lydiaVendorToken ?? null;
  if (account) {
    logger.debug(`${what}: submission ${submissionId} reads its request with its issuing Business`);
  } else {
    logger.warn(
      `${what}: submission ${submissionId} records no issuing Business (written before migration 120, or never issued)`
    );
  }
  return account;
}
