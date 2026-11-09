/**
 * Body of the single-permission endpoint: ONE key, granted or revoked.
 *
 * This is the shape a grid cell actually has. The whole-list form it replaced is what made two
 * administrators' compatible edits erase one another - see `setRoleBasePermission`.
 */
export interface SetRolePermissionDto {
  key: string;
  granted: boolean;
}

/** Response describing a workspace role's base permissions. */
export interface RolePermissionsResponseDto {
  roleId: string;
  roleName: string;
  permissions: string[];
}

/**
 * Body of the role-rename endpoint: the community's own display name for the role, or null / blank
 * to reset it to the localized default. Validated by `validateRoleLabel`.
 */
export interface SetRoleLabelDto {
  label: string | null;
}
