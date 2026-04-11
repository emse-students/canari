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

export interface SendChannelMessageDto {
  senderId: string;
  ciphertext: string;
  nonce: string;
  keyVersion?: number;
  /** Client-generated UUID used as PK so the WS echo can be deduplicated. */
  messageId?: string;
}

export interface GetChannelMessagesQuery {
  userId: string;
  limit?: number;
}

export interface UpdateChannelImageDto {
  mediaId: string;
}
