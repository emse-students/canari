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

export interface ChannelDto {
  _id?: string;
  id?: string;
  workspaceId: string;
  name: string;
  visibility?: 'public' | 'private';
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
  keyVersion?: number;
}

export class ChannelService {
  private baseUrl: string;

  constructor() {
    // In browser, API routes are proxied by Vite/nginx.
    const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_CHANNEL_URL;
    if (env) {
      this.baseUrl = env;
    } else {
      this.baseUrl = ''; // Use relative path by default to hit the gateway
    }
  }

  private getAuthHeaders(init: HeadersInit = {}): HeadersInit {
    const headers = { 'Content-Type': 'application/json', ...init } as Record<string, string>;
    const token =
      typeof localStorage !== 'undefined' ? localStorage.getItem('canari_authToken') : '';
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  }

  private async handleError(res: Response) {
    if (!res.ok) {
      const text = await res.text();
      if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
        throw new Error(
          `API Error ${res.status}: Le service est injoignable (Bad Gateway). Veuillez réessayer plus tard.`
        );
      }
      throw new Error(text || `API Error ${res.status}`);
    }
  }

  async healthCheck() {
    const res = await fetch(`${this.baseUrl}/api/channels/health`);
    return res.json();
  }

  async createWorkspace(dto: CreateWorkspaceDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/workspaces`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto>;
  }

  async getWorkspaceBySlug(slug: string) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/workspaces/by-slug/${encodeURIComponent(slug)}`,
      {
        headers: this.getAuthHeaders(),
      }
    );
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto>;
  }

  async listUserWorkspaces(userId: string) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/workspaces/user/${encodeURIComponent(userId)}`,
      {
        headers: this.getAuthHeaders(),
      }
    );
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto[]>;
  }

  async createChannel(dto: CreateChannelDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async createRole(dto: CreateRoleDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/roles/`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async listChannels(workspaceId: string, userId: string) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/workspace/${workspaceId}/user/${userId}`,
      {
        headers: this.getAuthHeaders(),
      }
    );
    await this.handleError(res);
    return res.json() as Promise<ChannelDto[]>;
  }

  async joinChannel(channelId: string, dto: ChannelJoinDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/${channelId}/members/join`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async updateMemberRole(channelId: string, dto: ChannelUpdateRoleDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/${channelId}/members/role`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async sendMessage(channelId: string, dto: SendChannelMessageDto) {
    const res = await fetch(`${this.baseUrl}/api/channels/${channelId}/messages`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async listMessages(channelId: string, userId: string, limit = 100) {
    const res = await fetch(
      `${this.baseUrl}/api/channels/${channelId}/messages?userId=${userId}&limit=${limit}`,
      {
        headers: this.getAuthHeaders(),
      }
    );
    await this.handleError(res);
    return res.json();
  }
}

export const channelService = new ChannelService();
