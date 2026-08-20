/** Body of the set-role-permissions endpoint: the full base-permission set for a workspace role. */
export interface SetRolePermissionsDto {
  permissions: string[];
}

/**
 * Body of the single-permission endpoint: ONE key, granted or revoked.
 *
 * This is the shape a grid cell actually has. The whole-list form above is what the click used to be
 * sent as, and what made two administrators' compatible edits erase one another - see
 * `setRoleBasePermission`.
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
