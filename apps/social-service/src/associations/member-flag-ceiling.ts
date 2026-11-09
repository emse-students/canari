import { BadRequestException, ForbiddenException, type Logger } from '@nestjs/common';
import { ADMIN_ASSOCIATION_ERROR } from './admin-catalogue';
import {
  ALL_PERMISSION_FLAGS,
  AssociationPermissionFlag,
  SUPER_ADMIN_EXCLUDED_FLAGS,
} from './entities/association-member.entity';

/**
 * THE GRANT CEILING: AN ORDINARY MEMBER MAY CHANGE ONLY THE FLAGS IT HOLDS ITSELF (2026-11-02).
 *
 * `MANAGE_MEMBERS` says WHO may write a member's bitmask; it never said WHICH bits. Until this file,
 * a member holding it could write any bitmask, so it could hand out (to someone else or to itself) a
 * flag it did not hold. The ceiling is the second half of the question, judged at the WRITE, in the
 * service, so no route reaches a member bitmask without it.
 *
 * THREE STANDINGS (owner, 2026-11-02):
 * - **the platform administrator**: no ceiling.
 * - **a BDE super-admin of this association** (`MANAGE_ASSO` in its parent BDE, WP-D2): NO
 *   CEILING EITHER on member writes - it may grant any flag, to anyone, itself included. A BDE
 *   officer is often also the president of another association and must be able to seat themself
 *   there with full rights. `SUPER_ADMIN_EXCLUDED_FLAGS` keeps its meaning, which is about
 *   INHERITANCE, not granting: the BDE role never EXERCISES `POST_AS_ASSO` or
 *   `MANAGE_PAYOUT_ACCOUNT` on an association through `mayAct`; only an explicit membership row
 *   carries them. Writing such a row is therefore a visible act, and every super-admin write that
 *   grants an excluded flag is logged for audit (`logSuperAdminExcludedGrant`).
 * - **an ordinary member holding `MANAGE_MEMBERS`**: capped at its own row.
 *
 * ONE RULE COVERS GRANTING, REVOKING AND REMOVING: the bits a write CHANGES (`before XOR after`)
 * must all sit under the ceiling. A bit outside it is neither added nor removed - it is not the
 * granter's to decide either way. Revoking is held to the same rule because a flag a granter does
 * not hold is one it cannot judge the removal of (the treasurer's payout right). REMOVING A MEMBER
 * is a revocation of everything it holds (`before` = its flags, `after` = 0): otherwise a member
 * holding only `MANAGE_MEMBERS` could remove the treasurer and re-add them with nothing. So removing
 * a target above the remover's ceiling takes a super-admin or the platform admin; LEAVING (removing
 * oneself, the "Quitter" button, `DELETE :id/members/me`) is judged by neither, and only the
 * last-member-manager guard can refuse it.
 */

/** The typed code of a write that changes a flag outside the granter's ceiling. */
export const MEMBER_FLAGS_BEYOND_GRANTER = 'MEMBER_FLAGS_BEYOND_GRANTER';

/**
 * The typed code of a removal that would leave an association with nobody holding
 * `MANAGE_MEMBERS` - its last member manager leaving, or being removed (owner, 2026-11-03: every
 * member may leave from the association's page, except its last member manager).
 */
export const LAST_MEMBER_MANAGER = 'ASSOCIATION_LAST_MEMBER_MANAGER';

/** Who is writing a member row - the identity the gateway vouched for. */
export interface MemberGranter {
  userId: string;
  isGlobalAdmin: boolean;
}

/** The three facts a ceiling is computed from, read by the service. */
export interface GranterStanding {
  isGlobalAdmin: boolean;
  /** `MANAGE_ASSO` in this association's parent BDE (`isAssociationSuperAdminOf`, WP-D2). */
  isSuperAdminOf: boolean;
  /** The granter's own bitmask in this association; 0 when not a member. */
  ownPermissions: number;
}

/**
 * The bits a granter may change on a member of one association: every flag for the platform
 * administrator and for a BDE super-admin of it; otherwise the granter's own row.
 */
export function grantCeiling(standing: GranterStanding): number {
  if (standing.isGlobalAdmin || standing.isSuperAdminOf) return ALL_PERMISSION_FLAGS;
  return standing.ownPermissions & ALL_PERMISSION_FLAGS;
}

/** The bits a write from `before` to `after` changes that `ceiling` does not cover. */
export function flagsBeyondCeiling(ceiling: number, before: number, after: number): number {
  return (before ^ after) & ~ceiling;
}

/** The enum names of the bits set in `mask`, for a log line a reader can act on. */
export function flagNames(mask: number): string[] {
  return Object.entries(AssociationPermissionFlag)
    .filter(([, value]) => typeof value === 'number' && (mask & value) !== 0)
    .map(([name]) => name);
}

/**
 * Refuses (403, typed) a member write that changes a bit outside the granter's ceiling. Logged at
 * WARN: the current editor never offers such a bit, but an older installed client still does.
 */
export function assertWithinGrantCeiling(
  logger: Logger,
  ceiling: number,
  before: number,
  after: number,
  ctx: { associationId: string; what: string }
): void {
  const beyond = flagsBeyondCeiling(ceiling, before, after);
  if (beyond === 0) return;
  logger.warn(
    `[MEMBER-CEILING] ${ctx.what} refused: association=${ctx.associationId} beyond=${flagNames(beyond).join('|')}`
  );
  throw new ForbiddenException({
    code: MEMBER_FLAGS_BEYOND_GRANTER,
    message: 'A member right can only be granted or revoked by someone who holds it',
  });
}

/**
 * The rights whose grant BY A BDE SUPER-ADMIN is audited: the two the BDE role does not inherit
 * (`SUPER_ADMIN_EXCLUDED_FLAGS`), plus `MANAGE_PRODUCTS`. That one IS inherited, but holding it on an
 * explicit row is what makes its holder one of the association's OWN managers - the standing that
 * accepts a list's payment delegation (owner rule: acceptance belongs to the receiver's managers).
 * A super-admin seating itself with it is therefore a visible act, like the other two. Auditing
 * changes nothing about who may grant it.
 */
export const SUPER_ADMIN_AUDITED_GRANTS =
  SUPER_ADMIN_EXCLUDED_FLAGS | AssociationPermissionFlag.MANAGE_PRODUCTS;

/**
 * THE AUDIT LINE of a BDE super-admin writing a row that carries a right in
 * `SUPER_ADMIN_AUDITED_GRANTS`: at INFO, naming the association and the flags, never a user. Logged
 * only for a granter that is a super-admin of the association and not the platform administrator,
 * and only for an audited bit the write ADDS.
 */
export function logSuperAdminExcludedGrant(
  logger: Logger,
  standing: GranterStanding,
  before: number,
  after: number,
  ctx: { associationId: string; what: string }
): void {
  if (standing.isGlobalAdmin || !standing.isSuperAdminOf) return;
  const granted = after & ~before & SUPER_ADMIN_AUDITED_GRANTS;
  if (granted === 0) return;
  logger.log(
    `[MEMBER-CEILING] ${ctx.what}: a BDE super-admin granted ${flagNames(granted).join('|')} on association ${ctx.associationId}`
  );
}

/**
 * THE ONE INSTITUTION RULE OF A MEMBER WRITE (D20, owner 2026-11-02): AN INSTITUTION'S MEMBERS ARE
 * THE PLATFORM ADMINISTRATOR'S ALONE - being personnel proves nothing, and its members speak as the
 * School. Two consequences, one code (`ADMIN_ASSOCIATION_INSTITUTION_MEMBERS_PLATFORM_ONLY`, the
 * code the admin create form already reads):
 * - anyone but the platform administrator writing an institution's member is a 403;
 * - a write that ADDS `MANAGE_MEMBERS` to an institution's member is a 400, the platform admin's
 *   included: the right would name a member manager the first branch refuses anyway. Refused, never
 *   silently narrowed - a mask the server rewrote is a member who believes they hold a right they
 *   do not. Revoking it (an older row) stays allowed.
 * Called from every member write (`insertMembership`, `updateMemberRole`, `removeMember`), so the
 * admin create's first admin and the roster editor obey the same rule.
 */
export function assertInstitutionMemberWrite(
  logger: Logger,
  kind: string | null,
  granter: MemberGranter,
  before: number,
  after: number,
  ctx: { associationId: string; what: string }
): void {
  if (kind !== 'institution') return;
  if (!granter.isGlobalAdmin) {
    logger.warn(
      `[MEMBER-CEILING] ${ctx.what} refused: institution ${ctx.associationId} members are the platform admin's`
    );
    throw new ForbiddenException({
      code: ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY,
      message: "Only the platform administrator manages an institution's members.",
    });
  }
  const added = after & ~before & AssociationPermissionFlag.MANAGE_MEMBERS;
  if (added === 0) return;
  logger.warn(
    `[MEMBER-CEILING] ${ctx.what} refused: institution ${ctx.associationId} member asked MANAGE_MEMBERS`
  );
  throw new BadRequestException({
    code: ADMIN_ASSOCIATION_ERROR.INSTITUTION_MEMBERS_PLATFORM_ONLY,
    message: "Only the platform administrator manages an institution's members.",
  });
}
