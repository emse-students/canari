export interface ChannelPermissionOverrideDto {
  roleId: string;
  permission: string;
  value: 'allow' | 'deny' | 'neutral';
}

export interface SetChannelPermissionOverrideDto {
  roleId: string;
  permissionKey: string;
  value: 'allow' | 'deny' | 'neutral';
}

export interface SetChannelPermissionsDto {
  overrides: ChannelPermissionOverrideDto[];
}

export interface ChannelPermissionsResponseDto {
  channelId: string;
  usePermissionOverrides: boolean;
  roles: Array<{ id: string; name: string; priority: number }>;
  overrides: Array<{
    roleId: string;
    roleName: string;
    permission: string;
    value: 'allow' | 'deny';
  }>;
}

export interface EffectivePermissionsResponseDto {
  channelId: string;
  userId?: string;
  permissions: string[];
}

export interface SetRolePermissionsDto {
  permissions: string[];
}

export interface RolePermissionsResponseDto {
  roleId: string;
  roleName: string;
  permissions: string[];
}
