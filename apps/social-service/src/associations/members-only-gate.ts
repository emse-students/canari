import { BadRequestException, ConflictException, type Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { Association } from './entities/association.entity';
import { MEMBERS_ONLY_WITHOUT_COTISATION } from './product-checkout';

/**
 * Refuses (400 `MEMBERS_ONLY_WITHOUT_COTISATION`) a product or a partnership card SAVED as reserved
 * to cotisants (`membersOnly`) by an association with no cotisation mode: `membersOnly` means "holds
 * an active cotisation tier of this association", and with no mode there is no tier to hold, so it
 * would be offered to nobody. A product's `requiredTags` take precedence over `membersOnly` at
 * purchase (`assertCanPurchase`), so a product gated by tags is not asked; a card has none.
 *
 * ONE rule for both savers (`ProductsService`, `PartnershipsService`). The reverse order - an
 * association CLEARING its mode while such rows exist - is refused by
 * {@link assertCotisationModeClearable} (409 `COTISATION_MODE_IN_USE`), and the two are ordered on
 * the association row by {@link lockAndAssertMembersOnlyGateable}.
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

/** The body `code` of the 409 an association gets for clearing a cotisation mode that rows still need. */
export const COTISATION_MODE_IN_USE = 'COTISATION_MODE_IN_USE';

/**
 * The SAVE side of the lock order: takes the association row `FOR SHARE` on the save's own
 * transaction, then judges the gate on the row it just read. The clear side takes the same row
 * `FOR UPDATE` before counting ({@link assertCotisationModeClearable}), so a clear and a members-only
 * save cannot both pass: one waits for the other's commit and then reads it. Only a save that
 * actually turns the gate on takes it (SHARE, so concurrent saves do not queue behind each other).
 * The caller must write its row on the SAME `manager`, or the lock ends before the row exists.
 *
 * @returns the locked association row (null when it does not exist, left to the caller's 404).
 */
export async function lockAndAssertMembersOnlyGateable(
  manager: EntityManager,
  associationId: string,
  membersOnly: boolean,
  requiredTags: readonly string[] | null,
  logger: Logger,
  subject: string
): Promise<Association | null> {
  const asso = await manager.findOne(Association, {
    where: { id: associationId },
    lock: { mode: 'pessimistic_read' },
  });
  if (asso) assertMembersOnlyGateable(asso, membersOnly, requiredTags, logger, subject);
  return asso;
}

/**
 * Refuses (409 `COTISATION_MODE_IN_USE`, nothing written) clearing a cotisation mode while an ACTIVE
 * product or partnership card is reserved to cotisants: with no mode `tierFactsOf` answers null, so
 * `isBuyerCotisant` is false for everyone and those rows would stay listed, greyed and refused to all.
 * The association row is locked `FOR UPDATE` FIRST (see {@link lockAndAssertMembersOnlyGateable}); the
 * check is made on the mode read UNDER that lock, so it asks only of a real transition. A product
 * gated by `requiredTags` is not counted (the tags take precedence at purchase), nor is an inactive row.
 * Must run inside the transaction that then writes the clear.
 */
export async function assertCotisationModeClearable(
  manager: EntityManager,
  associationId: string,
  logger: Logger
): Promise<void> {
  const locked = await manager.findOne(Association, {
    where: { id: associationId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!locked?.cotisationMode) return;
  const products: { id: string; name: string }[] = await manager.query(
    `SELECT id, name FROM association_products
      WHERE "associationId" = $1 AND "membersOnly" AND "isActive"
        AND cardinality(COALESCE("requiredTags", '{}')) = 0`,
    [associationId]
  );
  const cards: { id: string; title: string }[] = await manager.query(
    `SELECT id, title FROM partnership_cards
      WHERE "associationId" = $1 AND "membersOnly" AND "isActive"`,
    [associationId]
  );
  if (products.length === 0 && cards.length === 0) return;
  logger.log(
    `[COTISATION] clear refused (${COTISATION_MODE_IN_USE}): assoc=${associationId.slice(0, 8)} still has ` +
      `${products.length} members-only product(s) and ${cards.length} members-only card(s)`
  );
  throw new ConflictException({
    code: COTISATION_MODE_IN_USE,
    message: 'Untick "reserved to cotisants" on these rows before clearing the cotisation mode.',
    products: products.map((p) => ({ id: p.id, name: p.name })),
    cards: cards.map((c) => ({ id: c.id, title: c.title })),
  });
}
