import { ForbiddenException, type Logger } from '@nestjs/common';
import { AssociationPermissionFlag, typeExcludedFlags } from './entities/association-member.entity';
import type { Association } from './entities/association.entity';
import { isDelegating } from './payment-delegation.util';

/**
 * WHO MAY COLLECT MONEY, AND HOW (owner, 2026-11-02 - replacing "which KIND may sell" of 2026-10-31).
 *
 * The question is no longer whether a type sells, but whether THIS ENTITY may collect NOW:
 * - an ASSOCIATION always - through its own Lydia account, or a delegation it chose;
 * - a LIST only through an APPROVED payment delegation to an association that accepted it - it
 *   keeps the shop, the cotisation and every paid feature, but holds no Lydia account of its own;
 * - an INSTITUTION never.
 *
 * Each kind's mode is DERIVED from `TYPE_EXCLUDED_FLAGS` (the one per-kind table, next to
 * `SUPER_ADMIN_EXCLUDED_FLAGS`), never written a second time: a kind excluded from the shop collects
 * nothing; a kind excluded from the payout account alone collects through a delegate. An unknown
 * kind excludes every flag, so it collects nothing - the allowlist stays closed by default.
 *
 * It judges NEW WRITES at their entry (a priced product, a cotisation, a priced form, a delegation
 * request or approval, a Lydia link): a row that already exists is never deleted or rewritten here.
 * Whether the payments of an entity that MAY collect are READY (its own or its delegate's Lydia
 * validated) is the separate readiness answer, `resolvePaymentTarget`.
 */
export type CollectionMode = 'own-account' | 'delegate-only' | 'never';

/** The typed code refusing a write that collects money on an institution (or an unknown kind). */
export const ASSOCIATION_KIND_DOES_NOT_SELL = 'ASSOCIATION_KIND_DOES_NOT_SELL';

/**
 * The typed code refusing a paid write on a LIST that has no APPROVED payment delegation: the
 * client words it as "choose the association whose Lydia account receives your payments" and links
 * to the list's delegation section.
 */
export const LIST_DELEGATE_REQUIRED = 'LIST_DELEGATE_REQUIRED';

/** The typed code refusing a Lydia Business of a list's own - it collects only through a delegate. */
export const LIST_NO_OWN_LYDIA_ACCOUNT = 'LIST_NO_OWN_LYDIA_ACCOUNT';

/** How an entity of `type` may collect, derived from the kind's excluded flags. */
export function collectionModeOf(type: string): CollectionMode {
  const excluded = typeExcludedFlags(type);
  if ((excluded & AssociationPermissionFlag.MANAGE_PRODUCTS) !== 0) return 'never';
  if ((excluded & AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT) !== 0) return 'delegate-only';
  return 'own-account';
}

/** The columns the predicate reads: the kind and the delegation. */
export type CollectionSubject = Pick<
  Association,
  'id' | 'type' | 'paymentDelegationStatus' | 'paymentParentAssociationId'
>;

/**
 * THE ONE PREDICATE: may this entity collect money now? An association always; a list only while
 * it holds an APPROVED delegation (`isDelegating`); an institution never.
 */
export function mayCollect(subject: Omit<CollectionSubject, 'id'>): boolean {
  switch (collectionModeOf(subject.type)) {
    case 'own-account':
      return true;
    case 'delegate-only':
      return isDelegating(subject);
    case 'never':
      return false;
  }
}

/**
 * Refuses (403, typed) a write that collects money on an entity that may not collect now
 * (`mayCollect`). An institution is `ASSOCIATION_KIND_DOES_NOT_SELL`, logged at ERROR (the client
 * never offers it); a list without an approved delegate is `LIST_DELEGATE_REQUIRED`, logged at WARN
 * (a reachable state the client explains: the delegation was revoked, or never accepted).
 */
export function assertMayCollect(logger: Logger, subject: CollectionSubject, what: string): void {
  const mode = collectionModeOf(subject.type);
  if (mayCollect(subject)) {
    logger.debug(
      `[COLLECT] ${what} allowed: ${subject.type} ${subject.id.slice(0, 8)} (${mode}, ` +
        `delegation=${subject.paymentDelegationStatus ?? 'none'})`
    );
    return;
  }
  if (mode === 'delegate-only') {
    logger.warn(
      `[COLLECT] ${what} refused: ${subject.type} ${subject.id.slice(0, 8)} has no approved payment ` +
        `delegation (status=${subject.paymentDelegationStatus ?? 'none'})`
    );
    throw new ForbiddenException({
      code: LIST_DELEGATE_REQUIRED,
      message: `A ${subject.type} collects only through an approved payment delegation`,
    });
  }
  logger.error(
    `[COLLECT] ${what} refused: ${subject.type} ${subject.id.slice(0, 8)} collects nothing`
  );
  throw new ForbiddenException({
    code: ASSOCIATION_KIND_DOES_NOT_SELL,
    message: `A ${subject.type} does not sell or collect money`,
  });
}

/**
 * Refuses a payment-delegation REQUEST from an entity of `type` that never collects (an
 * institution). A list may request one: it is the only way it reaches `mayCollect`.
 */
export function assertMayRequestDelegation(logger: Logger, id: string, type: string): void {
  if (collectionModeOf(type) !== 'never') return;
  logger.error(`[COLLECT] delegation request refused: ${type} ${id.slice(0, 8)} collects nothing`);
  throw new ForbiddenException({
    code: ASSOCIATION_KIND_DOES_NOT_SELL,
    message: `A ${type} does not sell or collect money`,
  });
}

/**
 * Refuses an entity of `type` as the RECEIVER of a delegation, or as the holder of a Lydia
 * Business of its own: only a kind with its own account may (an association). A list answers
 * `LIST_NO_OWN_LYDIA_ACCOUNT`, an institution `ASSOCIATION_KIND_DOES_NOT_SELL`.
 */
export function assertMayHoldOwnAccount(
  logger: Logger,
  id: string,
  type: string,
  what: string
): void {
  const mode = collectionModeOf(type);
  if (mode === 'own-account') return;
  const code =
    mode === 'delegate-only' ? LIST_NO_OWN_LYDIA_ACCOUNT : ASSOCIATION_KIND_DOES_NOT_SELL;
  logger.error(
    `[COLLECT] ${what} refused: ${type} ${id.slice(0, 8)} holds no Lydia account of its own (${code})`
  );
  throw new ForbiddenException({
    code,
    message: `A ${type} holds no payment account of its own`,
  });
}

/**
 * A member's bitmask as it may be WRITTEN for an entity of `type`: the kind's excluded flags
 * (`TYPE_EXCLUDED_FLAGS`) are stripped, whatever the client sent - a list keeps the shop and loses
 * the payout account, an institution loses both. Applied to writes only - a row written before keeps
 * its bits, which open nothing (`mayAct` reads the same table).
 */
export function writablePermissions(type: string, permissions: number): number {
  return permissions & ~typeExcludedFlags(type);
}
