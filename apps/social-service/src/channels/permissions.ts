// ─── Unified permission registry ───

/**
 * WHAT IS NOT HERE, AND WHY IT WILL NOT COME BACK.
 *
 * `channel.access` and `channel.send` were in this registry from the start, shown in the community
 * permission grid, and enforced NOWHERE - eight rows in a matrix of which two decided nothing. They
 * were removed on 2026-08-19 rather than wired up, because wiring them would have been the mistake:
 *
 *  - **`channel.access` decides nothing that is not already decided.** A public salon is visible to
 *    every member of the community, and a private one to the people added to it. Those two facts
 *    settle every case, so a per-role read permission could only ever agree with them or contradict
 *    them - and a permission that may contradict the rule the server actually enforces is a lie in
 *    a panel, which is worse than an absent row.
 *  - **`writePolicy` is strictly more expressive than a community-wide send switch.** It is decided
 *    PER SALON, which is where the question is actually asked; one switch across the whole
 *    community cannot express "announcements are admin-only, everything else is open", and that is
 *    the only shape anyone wants.
 *
 * So the honest registry is the one below: every key in it is read by something.
 */
export const CHANNEL_PERMISSIONS = {
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

/**
 * Keys this server used to accept and no longer has, kept ONLY so a write can tell them apart from
 * a key that never existed.
 *
 * A client built before 2026-08-19 still renders both in its grid and sends them on every role
 * edit. `setRoleBasePermissions` drops these and refuses anything else unknown, which is the
 * difference between an old client and a wrong one. Delete this list, and that branch, on the date
 * on [legacy-compatibility](../../../../docs/wiki/legacy-compatibility.md).
 */
export const RETIRED_PERMISSIONS: string[] = ['channel.access', 'channel.send'];

/** Permissions of the Administrator role (priority 100) - every permission. */
export const DEFAULT_ADMIN_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
  CHANNEL_PERMISSIONS.MANAGE_ROLES,
  CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
];

/** Permissions of the Moderateur role (priority 50). */
export const DEFAULT_MODERATOR_PERMISSIONS: ChannelPermission[] = [
  CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  CHANNEL_PERMISSIONS.INVITE_MEMBERS,
  CHANNEL_PERMISSIONS.KICK_MEMBERS,
];

/**
 * Permissions of the Membre role (priority 10), and it is EMPTY on purpose.
 *
 * Reading and writing follow from being a member of the community and from the salon's own
 * `writePolicy`; neither was ever decided by a row in this list. An empty array is the accurate
 * statement of that, and it costs nothing - `memberHasWorkspacePermission` simply never matches.
 */
export const DEFAULT_MEMBER_PERMISSIONS: ChannelPermission[] = [];

/**
 * Mapping: old permission key (channel-role.entity) → new unified permission key.
 *
 * `SEND_MESSAGES` is deliberately absent: it mapped to `channel.send`, which no longer exists, so a
 * legacy row carrying it now normalizes to nothing at all - the same end state migration
 * `044_drop_unenforced_channel_permissions.sql` puts the stored rows in.
 */
export const LEGACY_PERMISSION_MAPPING: Record<string, ChannelPermission> = {
  MANAGE_WORKSPACE: CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
  MANAGE_CHANNELS: CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  MANAGE_ROLES: CHANNEL_PERMISSIONS.MANAGE_ROLES,
  MODERATE_MESSAGES: CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  INVITE_USERS: CHANNEL_PERMISSIONS.INVITE_MEMBERS,
};
