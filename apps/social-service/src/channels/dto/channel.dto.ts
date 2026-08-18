export interface CreateWorkspaceDto {
  slug: string;
  name: string;
  createdBy: string;
}

/** Reorders the calling user's communities: `orderedIds` in the desired top-to-bottom order. */
export interface ReorderWorkspacesDto {
  orderedIds: string[];
}

/**
 * A community's one live invite link. The bounds travel with the token because a link a human can
 * reason about has to show what it is bounded by - a token alone cannot say whether it expires.
 */
export interface WorkspaceInviteDto {
  token: string;
  /** ISO-8601, or null for a link that never expires. */
  expiresAt: string | null;
  /** Cap on accepted joins, or null for unlimited. */
  maxUses: number | null;
  /** Joins already accepted through this token. */
  uses: number;
}

/** Body of the invite-link endpoint. `rotate` is the only way to replace the live token. */
export interface CreateWorkspaceInviteDto {
  expiresAt?: string | null;
  maxUses?: number | null;
  rotate?: boolean;
}

export interface CreateRoleDto {
  workspaceId: string;
  name: string;
  priority: number;
  permissions: string[];
}

export interface CreateChannelDto {
  workspaceId: string;
  name: string;
  visibility?: 'public' | 'private';
  actorUserId: string;
}

export interface RenameChannelDto {
  name: string;
}

/**
 * Who may post in a channel:
 * - `everyone`: any member with access (default).
 * - `admins_moderators`: only roles carrying channel.moderate or workspace.manage.
 * - `admins`: only roles carrying workspace.manage.
 */
export type ChannelWritePolicy = 'everyone' | 'admins_moderators' | 'admins';

/** The three valid write policies, for runtime validation. */
export const CHANNEL_WRITE_POLICIES: ChannelWritePolicy[] = [
  'everyone',
  'admins_moderators',
  'admins',
];

/** Body of the update-channel-access endpoint (the actor is taken from the auth header). */
export interface UpdateChannelAccessDto {
  isPrivate: boolean;
  allowedUserIds: string[];
  writePolicy?: ChannelWritePolicy;
}

/** Body of the update-workspace-member-role endpoint (the actor is taken from the auth header). */
export interface UpdateWorkspaceMemberRoleDto {
  roleName: string;
}

export interface ChannelJoinDto {
  userId: string;
  roleName?: string;
  actorUserId: string;
}

export interface ChannelLeaveDto {
  userId: string;
}

export interface ChannelInviteDto {
  targetUserId: string;
  actorUserId: string;
  roleName?: string;
}

export interface ChannelKeyDistributionPayloadDto {
  type: 'channel_key_distribution';
  channelId: string;
  channelName?: string;
  keyVersion: number;
  encryptedChannelKey: string;
  epochKeys?: Array<{
    keyVersion: number;
    encryptedChannelKey: string;
  }>;
  distributionId: string;
  issuedAt: string;
  invitedBy: string;
}

export interface ChannelBootstrapDto {
  channelId: string;
  keyVersion: number;
  newEpochBaseKey: string;
}

export interface ChannelHistoryKeysDto {
  channelId: string;
  latestKeyVersion: number;
  epochKeys: Array<{
    keyVersion: number;
    encryptedChannelKey: string;
  }>;
}

export interface MarkDistributionReceivedDto {
  keyVersion: number;
}

export interface ChannelUpdateRoleDto {
  targetUserId: string;
  actorUserId: string;
  roleName: string;
}

/**
 * Label-free poll descriptor sent alongside an encrypted poll message.
 * Only opaque option IDs (and timing) reach the server; the matching question
 * and option labels live encrypted in the message `ciphertext`, so the server
 * can tally votes and enforce the deadline without ever seeing the plaintext.
 */
export interface ChannelPollInputDto {
  /** Opaque IDs (>= 2, unique) mirroring the encrypted option labels. */
  optionIds: string[];
  multipleChoice?: boolean;
  /** ISO date; omitted/null = no deadline. */
  endsAt?: string | null;
}

/**
 * Server-visible poll state persisted on a channel message's `metadata.poll`.
 * Holds no labels - only opaque option IDs and per-user selections - so it is
 * safe to expose to clients while keeping the poll's text end-to-end encrypted.
 */
export interface ChannelPollMeta {
  optionIds: string[];
  multipleChoice: boolean;
  endsAt: string | null;
  /** userId -> selected optionIds. The tally is derived from this client-side. */
  votesByUser: Record<string, string[]>;
}

/**
 * Per-channel push notification level a member can set for themselves.
 * - `all`: notify on every message (default when unset).
 * - `mentions`: notify only when the member is in a message's `mentionedUserIds`.
 * - `none`: never notify.
 */
export type ChannelNotificationLevel = 'all' | 'mentions' | 'none';

/** The three valid notification levels, for runtime validation. */
export const CHANNEL_NOTIFICATION_LEVELS: ChannelNotificationLevel[] = ['all', 'mentions', 'none'];

/** Body of the set-notification-level endpoint (the user is taken from the auth header). */
export interface SetChannelNotificationLevelDto {
  level: ChannelNotificationLevel;
}

export interface SendChannelMessageDto {
  senderId: string;
  ciphertext: string;
  nonce: string;
  keyVersion?: number;
  /** Client-generated UUID used as PK so the WS echo can be deduplicated. */
  messageId?: string;
  /** When present, this message is a poll: it is auto-pinned and accepts votes. */
  poll?: ChannelPollInputDto;
  /**
   * Cleartext list of mentioned user ids, attached by the sender so the server can route
   * the `mentions` notification level without decrypting the message. This intentionally
   * exposes WHO is mentioned (never the content) to the server.
   */
  mentionedUserIds?: string[];
}

export interface GetChannelMessagesQuery {
  userId: string;
  limit?: number;
  /**
   * Keyset cursor: when set, only messages strictly older than this ISO timestamp are
   * returned (newest-first). Enables paging back through channel history for older-message
   * loading and full-text search over the whole channel.
   */
  before?: string;
}

export interface UpdateChannelImageDto {
  mediaId: string;
}
