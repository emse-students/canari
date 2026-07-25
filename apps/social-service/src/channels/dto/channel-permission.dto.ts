/** Body of the set-role-permissions endpoint: the full base-permission set for a workspace role. */
export interface SetRolePermissionsDto {
  permissions: string[];
}

/** Response describing a workspace role's base permissions. */
export interface RolePermissionsResponseDto {
  roleId: string;
  roleName: string;
  permissions: string[];
}
