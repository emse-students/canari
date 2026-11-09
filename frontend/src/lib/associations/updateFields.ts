/**
 * WHICH RIGHT EACH `PATCH /associations/:id` FIELD ASKS - the client mirror of the server's
 * `UPDATE_FIELD_RIGHTS` (`apps/social-service/src/associations/association-update-rights.ts`).
 *
 * The server decides per field (owner, 2026-11-02): the profile is `EDIT_PROFILE`, the archive
 * `MANAGE_MEMBERS`, the cotisation settings `MANAGE_PRODUCTS`, the quota and a list's parent the
 * platform administrator alone. The edit screens draw a control from the SAME table, so a control
 * offered is a write accepted. `updateFields.test.ts` reads the server file and fails on any
 * difference between the two.
 */
import {
  AssociationPermissionFlag,
  mayActOnAssociation,
  type UpdateAssociationPayload,
} from '$lib/associations/api';

/** A field only the platform administrator writes. */
export const PLATFORM_ADMIN_ONLY = 'platform-admin';

export type UpdateField = keyof UpdateAssociationPayload;
export type UpdateFieldRight = AssociationPermissionFlag | typeof PLATFORM_ADMIN_ONLY;

/** The table itself; a field the payload type gains is a compile error until it is placed here. */
export const UPDATE_FIELD_RIGHTS: Record<UpdateField, UpdateFieldRight> = {
  name: AssociationPermissionFlag.EDIT_PROFILE,
  description: AssociationPermissionFlag.EDIT_PROFILE,
  bioMarkdown: AssociationPermissionFlag.EDIT_PROFILE,
  logoUrl: AssociationPermissionFlag.EDIT_PROFILE,
  color: AssociationPermissionFlag.EDIT_PROFILE,
  contactEmail: AssociationPermissionFlag.EDIT_PROFILE,
  promo: AssociationPermissionFlag.EDIT_PROFILE,
  name2: AssociationPermissionFlag.EDIT_PROFILE,
  logoMediaId2: AssociationPermissionFlag.EDIT_PROFILE,
  archived: AssociationPermissionFlag.MANAGE_MEMBERS,
  cotisationEnabled: AssociationPermissionFlag.MANAGE_PRODUCTS,
  cotisationMode: AssociationPermissionFlag.MANAGE_PRODUCTS,
  cotisationExpiresAt: AssociationPermissionFlag.MANAGE_PRODUCTS,
  documentQuotaBytes: PLATFORM_ADMIN_ONLY,
  parentAssociationId: PLATFORM_ADMIN_ONLY,
};

/** The fields the profile form sends: what `editRights().profile` is computed from. */
export const PROFILE_FORM_FIELDS: readonly UpdateField[] = [
  'name',
  'description',
  'bioMarkdown',
  'color',
  'contactEmail',
  'promo',
  'name2',
];

/**
 * Whether a reader in `ctx` may write EVERY field of `fields` - the server refuses the whole body
 * on one missing right, so a form is editable only when all of its fields are.
 */
export function mayWriteFields(
  fields: readonly UpdateField[],
  ctx: Parameters<typeof mayActOnAssociation>[1]
): boolean {
  return fields.every((field) => {
    const right = UPDATE_FIELD_RIGHTS[field];
    return right === PLATFORM_ADMIN_ONLY ? ctx.isGlobalAdmin : mayActOnAssociation(right, ctx);
  });
}
