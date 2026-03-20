export interface CreateWorkspaceDto {
  slug: string;
  name: string;
  createdBy: string;
}

export interface WorkspaceDto {
  _id: string;
  id?: string;
  slug: string;
  name: string;
  createdBy: string;
}

export interface CreateChannelDto {
  workspaceId: string;
  name: string;
  visibility?: 'public' | 'private';
  actorUserId: string;
}

export interface CreateRoleDto {
  workspaceId: string;
  name: string;
  priority: number;
  permissions: string[];
}

export interface ChannelJoinDto {
  userId: string;
  roleName?: string;
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
}

export class ChannelService {
  private baseUrl: string;

  constructor() {
    // In browser, API routes are proxied by Vite/nginx.
    this.baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005';
  }

  async healthCheck() {
    const res = await fetch(`${this.baseUrl}/api/channels/health`);
    return res.json();
  }

  async createWorkspace(dto: CreateWorkspaceDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/workspaces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<WorkspaceDto>;
  }

  async getWorkspaceBySlug(slug: string) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/workspaces/by-slug/${encodeURIComponent(slug)}`
    );
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<WorkspaceDto>;
  }

  async listUserWorkspaces(userId: string) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/workspaces/user/${encodeURIComponent(userId)}`
    );
    if (!res.ok) throw new Error(await res.text());
    return res.json() as Promise<WorkspaceDto[]>;
  }

  async createChannel(dto: CreateChannelDto) {
    const res = await fetch(`${this.baseUrl}/api/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async createRole(dto: CreateRoleDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/roles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async listChannels(workspaceId: string, userId: string) {
    const res = await fetch(`${this.baseUrl}/api/channels/workspace/${workspaceId}/user/${userId}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async joinChannel(channelId: string, dto: ChannelJoinDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/${channelId}/members/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async updateMemberRole(channelId: string, dto: ChannelUpdateRoleDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/${channelId}/members/role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async sendMessage(channelId: string, dto: SendChannelMessageDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async listMessages(channelId: string, userId: string, limit = 100) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/${channelId}/messages?userId=${userId}&limit=${limit}`
    );
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }
}

export const channelService = new ChannelService();
