import { ForbiddenException, type Logger } from '@nestjs/common';

/**
 * THE KINDS OF ASSOCIATION THAT MAY SELL OR COLLECT MONEY (owner, 2026-10-31).
 *
 * An allowlist, so a kind nobody listed stays refused: a campaign LIST and an INSTITUTION sell
 * nothing - no products, no payout/Lydia account, no priced form. The client already draws none of
 * their shop or payment sections (`EDIT_SECTIONS_BY_KIND`); this is the same rule where the server
 * is the authority. It judges NEW WRITES only: a row that already exists is never deleted or
 * rewritten by it.
 */
export const SELLING_ASSOCIATION_TYPES: readonly string[] = ['association'];

/** The typed code of the refusal, so a client can tell it from a missing right. */
export const ASSOCIATION_KIND_DOES_NOT_SELL = 'ASSOCIATION_KIND_DOES_NOT_SELL';

/** Whether an association of `type` may sell or collect money. */
export function kindMaySell(type: string): boolean {
  return SELLING_ASSOCIATION_TYPES.includes(type);
}

/**
 * Refuses (403, typed, logged at ERROR: a client reached a write the UI never offers) a write that
 * sells or collects money on a kind that does not.
 */
export function assertKindMaySell(
  logger: Logger,
  associationId: string,
  type: string,
  what: string
): void {
  if (kindMaySell(type)) return;
  logger.error(
    `[SELL-KIND] ${what} refused: association ${associationId.slice(0, 8)} is a ${type}, which sells nothing`
  );
  throw new ForbiddenException({
    code: ASSOCIATION_KIND_DOES_NOT_SELL,
    message: `A ${type} does not sell or collect money`,
  });
}
