// ─── Répertoire unifié des permissions ───

export const CHANNEL_PERMISSIONS = {
  // ── Accès au canal ──
  ACCESS_CHANNEL: "channel.access",
  SEND_MESSAGES: "channel.send",

  // ── Gestion du canal ──
  MANAGE_CHANNEL: "channel.manage",
  MANAGE_MESSAGES: "channel.moderate",

  // ── Membres ──
  INVITE_MEMBERS: "member.invite",
  KICK_MEMBERS: "member.kick",

  // ── Rôles (workspace uniquement, pas overridable par canal) ──
  MANAGE_ROLES: "role.manage",
  MANAGE_WORKSPACE: "workspace.manage",
} as const;

export type ChannelPermission = (typeof CHANNEL_PERMISSIONS)[keyof typeof CHANNEL_PERMISSIONS];

/** Permissions du rôle Administrateur (priority 100) — toutes les permissions. */
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

/** Permission keys displayed as overridable cells in the PermissionGrid. */
export const PERMISSION_LABELS: Record<string, string> = {
  [CHANNEL_PERMISSIONS.ACCESS_CHANNEL]:
    "Voir et lire le canal",
  [CHANNEL_PERMISSIONS.SEND_MESSAGES]: "Envoyer messages et fichiers",
  [CHANNEL_PERMISSIONS.MANAGE_CHANNEL]: "Gérer le canal",
  [CHANNEL_PERMISSIONS.MANAGE_MESSAGES]: "Modérer les messages",
  [CHANNEL_PERMISSIONS.INVITE_MEMBERS]: "Inviter des membres",
  [CHANNEL_PERMISSIONS.KICK_MEMBERS]: "Expulser des membres",
  [CHANNEL_PERMISSIONS.MANAGE_ROLES]: "Gérer les rôles",
  [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE]: "Gérer la communauté",
};

/** Detailed tooltip descriptions for each permission. */
export const PERMISSION_TOOLTIPS: Record<string, string> = {
  [CHANNEL_PERMISSIONS.ACCESS_CHANNEL]:
    "Allows viewing the channel in the list and reading its messages.",
  [CHANNEL_PERMISSIONS.SEND_MESSAGES]:
    "Allows sending messages and files in this channel.",
  [CHANNEL_PERMISSIONS.MANAGE_CHANNEL]:
    "Permet de renommer, archiver ou modifier les paramètres de ce canal.",
  [CHANNEL_PERMISSIONS.MANAGE_MESSAGES]:
    "Permet d'épingler ou de supprimer les messages des autres membres.",
  [CHANNEL_PERMISSIONS.INVITE_MEMBERS]: "Permet d'inviter de nouveaux membres dans ce canal.",
  [CHANNEL_PERMISSIONS.KICK_MEMBERS]: "Permet d'expulser un membre de ce canal spécifique.",
  [CHANNEL_PERMISSIONS.MANAGE_ROLES]:
    "Permet de créer, modifier ou supprimer les rôles de la communauté.",
  [CHANNEL_PERMISSIONS.MANAGE_WORKSPACE]:
    "Donne tous les droits. Un administrateur a TOUJOURS toutes les permissions.",
};

/** Mapping: old permission key (channel-role.entity) → new unified permission key. */
export const LEGACY_PERMISSION_MAPPING: Record<string, ChannelPermission> = {
  MANAGE_WORKSPACE: CHANNEL_PERMISSIONS.MANAGE_WORKSPACE,
  MANAGE_CHANNELS: CHANNEL_PERMISSIONS.MANAGE_CHANNEL,
  MANAGE_ROLES: CHANNEL_PERMISSIONS.MANAGE_ROLES,
  SEND_MESSAGES: CHANNEL_PERMISSIONS.SEND_MESSAGES,
  MODERATE_MESSAGES: CHANNEL_PERMISSIONS.MANAGE_MESSAGES,
  INVITE_USERS: CHANNEL_PERMISSIONS.INVITE_MEMBERS,
};
