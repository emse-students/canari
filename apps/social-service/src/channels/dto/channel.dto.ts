export interface CreateWorkspaceDto {
  slug: string;
  name: string;
  createdBy: string;
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

export interface ChannelKickDto {
  targetUserId: string;
  actorUserId: string;
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

export interface SendChannelMessageDto {
  senderId: string;
  ciphertext: string;
  nonce: string;
  keyVersion?: number;
  /** Client-generated UUID used as PK so the WS echo can be deduplicated. */
  messageId?: string;
  /** When present, this message is a poll: it is auto-pinned and accepts votes. */
  poll?: ChannelPollInputDto;
}

export interface GetChannelMessagesQuery {
  userId: string;
  limit?: number;
}

export interface UpdateChannelImageDto {
  mediaId: string;
}
