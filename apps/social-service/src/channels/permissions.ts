// ─── Unified permission registry ───

export const CHANNEL_PERMISSIONS = {
  // ── Channel access ──
  ACCESS_CHANNEL: 'channel.access',
  SEND_MESSAGES: 'channel.send',

  // ── Channel management ──
  MANAGE_CHANNEL: 'channel.manage',
  MANAGE_MESSAGES: 'channel.moderate',

  // ── Members ──
  INVITE_MEMBERS: 'member.invite',
  KICK_MEMBERS: 'member.kick',

  // ── Roles (workspace only, not overridable per channel) ──
  MANAGE_ROLES: 'role.manage',
  MANAGE_WORKSPACE: 'workspace.manage',
} as const;

export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[keyof typeof CHANNEL_PERMISSIONS];

/** Permissions of the Administrator role (priority 100) - every permission. */
export const DEFAULT_ADMIN_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.ACCESS_CHANNEL,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
  CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
  CHANNEL_PERMISSIONS.MANAGE_ROLES,
  CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
];

/** Permissions du rôle Modérateur (priority 50). */
export const DEFAULT_MODERATOR_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.ACCESS_CHANNEL,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
];

/** Permissions du rôle Membre (priority 10). */
export const DEFAULT_MEMBER_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.ACCESS_CHANNEL,
  CHANNEL_PERMISSIONS.SEND_MESSAGES,
];

/** Mapping: old permission key (channel-role.entity) → new unified permission key. */
export const LEGACY_PERMISSION_MAPPING: Record<string, ChannelPermission> = {
  MANAGE_WORKSPACE: CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
  MANAGE_CHANNELS: CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  MANAGE_ROLES: CHANNEL_PERMISSIONS.MANAGE_ROLES,
  SEND_MESSAGES: CHANNEL_PERMISSIONS.SEND_MESSAGES,
  MODERATE_MESSAGES: CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  INVITE_USERS: CHANNEL_PERMISSIONS.INVITE_MEMBERS,
};
