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
 * A GroupInfo a member has just committed on the community's Graine distribution group, published
 * so the next device can external-join without anyone being online to Welcome it.
 */
export interface PublishDistributionGroupInfoDto {
  /** Serialized MLS GroupInfo, base64. */
  groupInfo: string;
  /** The epoch it was exported at. Monotonic server-side: a lower one is ignored, never an error. */
  baseEpoch: number;
  /**
   * The device publishing it, which is ALSO how the device that CREATED the MLS group enters the
   * group's delivery roster.
   *
   * That roster is written by the commit fan-out, where the activating device is the commit SENDER
   * - and a creator sends no commit, so it was never written into the group it had just made. It
   * therefore received nothing on it: not the next member's external-join commit, so its epoch
   * never moved and every seed it sealed was unreadable to them, and not their request for the
   * missing seed either, so nothing repaired it. A private salon with two members did not work.
   * Found on production 2026-08-20.
   */
  deviceId: string;
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
 * A poll as a client is TOLD it: the persisted state plus the one fact only this side can state.
 *
 * `endsAt` is an instant on the SERVER's clock, so a client comparing it to its own decides the
 * question with the wrong clock - and the margin is zero exactly when it matters. A poll closed
 * *now* is stamped with the server's now and read a few hundred milliseconds later against a client
 * clock that is behind it, so the comparison comes out FALSE; nothing re-runs it, and the card stays
 * open for ever. Measured on production 2026-08-25 (COMM-15): both clients rendered the freshly
 * closed poll as "0 min restante(s)" while the server refused every vote into it with a 403.
 *
 * The server already decides this to refuse those votes, with the clock that wrote the field.
 * `closed` is that same decision, carried to where it is rendered instead of re-derived from its
 * input. NEVER persisted: it is true of an instant, not of the row.
 */
export interface ServedChannelPollMeta extends ChannelPollMeta {
  /** Whether the poll is over. The server's statement, never a client's comparison. */
  closed: boolean;
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
  /**
   * The Graine session the sender sealed this message under, and which key of it.
   *
   * Both required, and required together: the key is HKDF(seed, sessionId, index), so a message
   * missing either is one nobody can ever open - including its author. The server holds no seed
   * and cannot supply a default for either.
   */
  senderSessionId: string;
  messageIndex: number;
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
  /**
   * True for a message that must never notify - a reaction (WP-40).
   *
   * Told rather than inferred: the server cannot read the body and must not have to guess whether
   * it is worth a push. Whether to ring a phone is the ONLY thing this flag says.
   */
  silent?: boolean;
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

/**
 * What a community lets a newcomer read. The two values are the whole vocabulary: anything else is
 * refused rather than coerced, because a value nobody recognises would silently become the default
 * on the very devices that decide what history to hand over.
 */
export type HistoryVisibility = 'shared' | 'joined';

export interface UpdateWorkspaceHistoryVisibilityDto {
  historyVisibility: HistoryVisibility;
}
