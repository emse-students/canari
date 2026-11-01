import { BadRequestException, type Logger } from '@nestjs/common';
import type { Association } from './entities/association.entity';
import { MEMBERS_ONLY_WITHOUT_COTISATION } from './product-checkout';

/**
 * Refuses (400 `MEMBERS_ONLY_WITHOUT_COTISATION`) a product or a partnership card SAVED as reserved
 * to cotisants (`membersOnly`) by an association with no cotisation mode: `membersOnly` means "holds
 * an active cotisation tier of this association", and with no mode there is no tier to hold, so it
 * would be offered to nobody. A product's `requiredTags` take precedence over `membersOnly` at
 * purchase (`assertCanPurchase`), so a product gated by tags is not asked; a card has none.
 *
 * ONE rule for both savers (`ProductsService`, `PartnershipsService`). What happens when an
 * association CLEARS its mode while such rows exist is not decided here
 * (docs/wiki/backlog.d/members-only-rows-outlive-a-cleared-cotisation-mode.md).
 *
 * @param subject What is being saved, for the log line (`product`, `partnership card`).
 */
export function assertMembersOnlyGateable(
  asso: Pick<Association, 'id' | 'cotisationMode'>,
  membersOnly: boolean,
  requiredTags: readonly string[] | null,
  logger: Logger,
  subject: string
): void {
  if (!membersOnly || (requiredTags ?? []).length > 0 || asso.cotisationMode) return;
  logger.log(
    `[COTISATION] refused (${MEMBERS_ONLY_WITHOUT_COTISATION}): a members-only ${subject} of ` +
      `assoc=${asso.id.slice(0, 8)}, which has no cotisation mode - it would be offered to nobody`
  );
  throw new BadRequestException({
    code: MEMBERS_ONLY_WITHOUT_COTISATION,
    message: 'Enable the cotisation before reserving this to cotisants.',
  });
}
