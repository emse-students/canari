import type { Logger } from '@nestjs/common';
import { ALL_CORE_FLAGS, AssociationPermissionFlag } from './entities/association-member.entity';
import { writablePermissions } from './selling-kinds';

/**
 * LEGACY SHIM - remove on or after 2027-05-03 (docs/wiki/legacy-compatibility.md, "an admin preset
 * without EDIT_PROFILE, posted by a build older than the flag").
 *
 * An app built before `EDIT_PROFILE` (bit 12, 2026-11-02; every store build up to 1.6.2) still
 * offers its "Administrateur" preset, which lacks the bit: an admin it adds would manage the roster
 * and could not edit the profile they always could. Such a build cannot be told apart by anything
 * but the mask, so a member ADD whose mask EQUALS one of those old presets is read as that preset
 * and receives `EDIT_PROFILE`. Never an update: a current app unticking "Modifier le profil" on a
 * full admin posts exactly such a mask, and that untick must hold; an old app re-applying its
 * preset to an existing member strips the bit visibly, and a current app re-ticks it. The set is DERIVED from today's constants with bit 12 taken out, then
 * narrowed per kind exactly as the old client's `adminPresetFor` narrowed it (the shop and payout
 * rights out for a kind that sells nothing) - never typed as numbers.
 */
export const LEGACY_EDIT_PROFILE_REMOVAL_DATE = '2027-05-03';

const OLD_CORE_FLAGS = ALL_CORE_FLAGS & ~AssociationPermissionFlag.EDIT_PROFILE;
const OLD_ADMIN_PRESET = OLD_CORE_FLAGS | AssociationPermissionFlag.MANAGE_PAYOUT_ACCOUNT;

/** Every admin preset a pre-`EDIT_PROFILE` build could post, for every kind. */
export const LEGACY_ADMIN_PRESETS: ReadonlySet<number> = new Set(
  (['association', 'list', 'institution'] as const).flatMap((kind) => [
    writablePermissions(kind, OLD_ADMIN_PRESET),
    writablePermissions(kind, OLD_CORE_FLAGS),
  ])
);

/**
 * `permissions` with `EDIT_PROFILE` ORed in when it is exactly an old admin preset AND the granter's
 * `ceiling` (`grantCeiling`, the member-flag ceiling) covers the bit, else unchanged: the shim never
 * hands out a right its granter could not grant by hand. Logged at debug as a legacy match, so the
 * traffic is measured before the shim is removed.
 */
export function withLegacyEditProfile(
  logger: Logger,
  permissions: number,
  ceiling: number,
  where: string
): number {
  if (!LEGACY_ADMIN_PRESETS.has(permissions)) return permissions;
  if ((ceiling & AssociationPermissionFlag.EDIT_PROFILE) === 0) {
    logger.debug(
      `[LEGACY] ${where}: mask ${permissions} is a pre-EDIT_PROFILE admin preset, but the granter does not hold EDIT_PROFILE - left as sent`
    );
    return permissions;
  }
  logger.debug(
    `[LEGACY] ${where}: mask ${permissions} is a pre-EDIT_PROFILE admin preset - EDIT_PROFILE added (shim until ${LEGACY_EDIT_PROFILE_REMOVAL_DATE})`
  );
  return permissions | AssociationPermissionFlag.EDIT_PROFILE;
}
