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

/**
 * Whether a role lets its holder GOVERN salons - create one, rename it, delete it, set its access
 * and its write policy. THE ONLY definition: every one of those writes refuses without it, and the
 * workspace listing hands the same answer to the client as `viewerCanManageChannels`, so the panel
 * offering the controls and the endpoint refusing them cannot disagree.
 *
 * Wider than `workspace.manage` on purpose: governing rooms is what `channel.manage` IS.
 */
export function roleGrantsChannelManagement(permissions: readonly string[]): boolean {
  return (
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL) ||
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
  );
}

/**
 * Whether a role lets its holder moderate a salon's messages - pin or unpin ANY message (the
 * author's own included: a pin shows on every screen), delete or close a poll on someone else's.
 * THE ONLY definition: every one of those endpoints refuses without it, the workspace listing hands
 * the same answer to the client as `viewerCanModerate`, and `workspace.role.changed` carries it as
 * `canModerate`, so the menu offering the action and the endpoint refusing it cannot disagree.
 *
 * `channel.manage` and `workspace.manage` subsume `channel.moderate`.
 */
export function roleGrantsModeration(permissions: readonly string[]): boolean {
  return (
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_MESSAGES) ||
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_CHANNEL) ||
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
  );
}

/**
 * Whether a role lets its holder manage roles - create them, edit what they grant, assign them.
 * THE ONLY definition: every role-management endpoint refuses without it, and an invitation that
 * grants more than the base role asks it too (`actorMayGrantRole`).
 */
export function roleGrantsRoleManagement(permissions: readonly string[]): boolean {
  return (
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_ROLES) ||
    permissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)
  );
}

/**
 * Whether an actor holding `actorPermissions` (the union over all their roles) may hand somebody a
 * role granting `grantedPermissions` - THE ONLY definition, asked wherever a role is granted: an
 * invitation naming a role, an assignment, a permission edit, a new role.
 *
 * Two conditions. The actor manages roles (`roleGrantsRoleManagement`), the same right the
 * role-management endpoints require. AND the role grants nothing the actor does not hold, so a grant
 * can never hand out more than its author has; `workspace.manage` holds every permission, so an
 * administrator may grant any role.
 *
 * The community's base role (the one an invite link grants) is not asked about here: granting it is
 * what inviting IS, and the caller exempts it before asking.
 */
export function actorMayGrantRole(
  actorPermissions: readonly string[],
  grantedPermissions: readonly string[]
): boolean {
  return (
    roleGrantsRoleManagement(actorPermissions) &&
    permissionsCover(actorPermissions, grantedPermissions)
  );
}

/**
 * Whether `actorPermissions` include everything `otherPermissions` grant - THE ONLY definition of
 * "holds at least as much", the bound on every grant (`actorMayGrantRole`) and every removal: an
 * actor may neither hand out nor take away more than they hold. `workspace.manage` holds every
 * permission.
 */
export function permissionsCover(
  actorPermissions: readonly string[],
  otherPermissions: readonly string[]
): boolean {
  if (actorPermissions.includes(CHANNEL_PERMISSIONS.MANAGE_WORKSPACE)) return true;
  return otherPermissions.every((p) => actorPermissions.includes(p));
}

/**
 * The refusal code of a removal - from the community or from a private salon - of a member whose
 * roles grant more than the actor holds (`permissionsCover`).
 */
export const REMOVAL_EXCEEDS_ACTOR = 'REMOVAL_EXCEEDS_ACTOR';

/**
 * The refusal code of an invitation asking to grant a role its author may not grant.
 * A CODE, so a client maps the refusal from what the server typed rather than from its prose.
 */
export const INVITE_ROLE_NOT_GRANTABLE = 'INVITE_ROLE_NOT_GRANTABLE';

/**
 * The refusal code of a role change - an assignment, a permission edit, a new role - that would
 * grant, or touch, more than the actor holds (`actorMayGrantRole`).
 */
export const ROLE_CHANGE_EXCEEDS_ACTOR = 'ROLE_CHANGE_EXCEEDS_ACTOR';

/**
 * The refusal code (409) of a membership write whose row is no longer the one it judged: its roles
 * or permissions changed since the read, or the membership is gone. Nothing was written; reading
 * the member again and retrying is the answer. Thrown by community and association role changes.
 */
export const MEMBER_CHANGED_MEANWHILE = 'MEMBER_CHANGED_MEANWHILE';

/**
 * The refusal code of a pin or unpin by a member who may not moderate - whoever wrote the message.
 * A CODE, so a client maps the refusal from what the server typed rather than from its prose.
 */
export const PIN_REQUIRES_MODERATION = 'PIN_REQUIRES_MODERATION';

/**
 * What the viewer's ROLES grant them in a workspace, reduced to the two facts a write decision
 * needs. Both are already computed wherever a decision is made - this type is what stops them
 * being re-derived a third time.
 */
export interface ViewerRoleStanding {
  /** Holds `workspace.manage` through at least one role. */
  canManage: boolean;
  /** Holds a role that grants message moderation (`channel.moderate`, or a permission subsuming it). */
  canModerate: boolean;
}

/**
 * Whether a salon's `writePolicy` lets this viewer post - THE ONLY definition, read by both sides.
 *
 * WHY IT IS A PURE FUNCTION AND NOT A METHOD. The server enforces the policy per message, in
 * `canWriteToChannel`, which loads the viewer's roles; the workspace listing already holds the same
 * two booleans for the viewer and hands them to the client. Those are the same decision asked in two
 * places, and until 2026-08-20 only the first one existed: the client never learned the policy at
 * all, so it offered a composer in a salon the server refused every message from, and the person
 * typing read the refusal as the app being broken.
 *
 * The two callers must not be able to disagree, so neither carries the rule.
 */
export function writePolicyAllows(
  policy: 'everyone' | 'admins_moderators' | 'admins',
  viewer: ViewerRoleStanding
): boolean {
  if (policy === 'everyone') return true;
  if (policy === 'admins') return viewer.canManage;
  return viewer.canModerate || viewer.canManage;
}
