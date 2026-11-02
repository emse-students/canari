import { AssociationPermissionFlag } from './entities/association-member.entity';
import type { UpdateAssociationDto } from './dto/association.dto';

/** A field only the platform administrator writes, whatever the caller's flags. */
export const PLATFORM_ADMIN_ONLY = 'platform-admin';

/** The right one `PATCH /associations/:id` field asks: a member flag, or the platform admin. */
export type UpdateFieldRight = AssociationPermissionFlag | typeof PLATFORM_ADMIN_ONLY;

/**
 * THE ONE TABLE OF WHICH RIGHT EACH `PATCH :id` FIELD ASKS (owner, 2026-11-02).
 *
 * `PATCH :id` used to be one flag (`MANAGE_MEMBERS`) with two exceptions written inline, so the
 * profile asked the roster right and a holder of `MANAGE_PRODUCTS` alone was offered the cotisation
 * settings and then refused at the guard. Every field now names its own right, and a body asks the
 * union of its fields'. `Record<keyof UpdateAssociationDto, ...>` makes a new DTO field a compile
 * error until it is placed here.
 *
 * The client mirrors it in `frontend/src/lib/associations/updateFields.ts`, and
 * `updateFields.test.ts` reads THIS file and fails on any difference.
 */
export const UPDATE_FIELD_RIGHTS: Record<keyof UpdateAssociationDto, UpdateFieldRight> = {
  name: AssociationPermissionFlag.EDIT_PROFILE,
  description: AssociationPermissionFlag.EDIT_PROFILE,
  bioMarkdown: AssociationPermissionFlag.EDIT_PROFILE,
  logoUrl: AssociationPermissionFlag.EDIT_PROFILE,
  color: AssociationPermissionFlag.EDIT_PROFILE,
  categoryId: AssociationPermissionFlag.EDIT_PROFILE,
  contactEmail: AssociationPermissionFlag.EDIT_PROFILE,
  promo: AssociationPermissionFlag.EDIT_PROFILE,
  name2: AssociationPermissionFlag.EDIT_PROFILE,
  logoMediaId2: AssociationPermissionFlag.EDIT_PROFILE,
  archived: AssociationPermissionFlag.MANAGE_MEMBERS,
  cotisationEnabled: AssociationPermissionFlag.MANAGE_PRODUCTS,
  cotisationMode: AssociationPermissionFlag.MANAGE_PRODUCTS,
  cotisationExpiresAt: AssociationPermissionFlag.MANAGE_PRODUCTS,
  documentQuotaBytes: PLATFORM_ADMIN_ONLY,
  // A list's parent is a statement about ANOTHER association, so no right held on this one may
  // rewrite it: set at creation, changed by the platform administrator.
  parentAssociationId: PLATFORM_ADMIN_ONLY,
};

/** The typed codes of a refused field, so a client tells them from each other and from a 404. */
export const ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY = 'ASSOCIATION_FIELD_PLATFORM_ADMIN_ONLY';
export const ASSOCIATION_FIELD_RIGHT_MISSING = 'ASSOCIATION_FIELD_RIGHT_MISSING';

/**
 * The fields of `dto` grouped by the right each asks. A key the table does not know (none can
 * reach here past the whitelisting ValidationPipe) is returned under `unknown`, so the caller
 * refuses rather than writes it.
 */
export function rightsAskedBy(dto: UpdateAssociationDto): {
  flags: Map<AssociationPermissionFlag, string[]>;
  platformAdmin: string[];
  unknown: string[];
} {
  const flags = new Map<AssociationPermissionFlag, string[]>();
  const platformAdmin: string[] = [];
  const unknown: string[] = [];
  for (const [field, value] of Object.entries(dto)) {
    if (value === undefined) continue;
    const right = (UPDATE_FIELD_RIGHTS as Record<string, UpdateFieldRight | undefined>)[field];
    if (right === undefined) unknown.push(field);
    else if (right === PLATFORM_ADMIN_ONLY) platformAdmin.push(field);
    else flags.set(right, [...(flags.get(right) ?? []), field]);
  }
  return { flags, platformAdmin, unknown };
}
