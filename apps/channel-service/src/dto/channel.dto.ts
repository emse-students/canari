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

export interface ChannelJoinDto {
  userId: string;
  roleName?: string;
  actorUserId: string;
}

export interface ChannelLeaveDto {
  userId: string;
}

export interface ChannelKickDto {
  targetUserId: string;
  actorUserId: string;
}

export interface SendChannelMessageDto {
  senderId: string;
  plaintext: string;
}

export interface GetChannelMessagesQuery {
  userId: string;
  limit?: number;
}
