export interface CreateWorkspaceDto {
  slug: string;
  name: string;
}

export interface WorkspaceDto {
  _id: string;
  id?: string;
  slug: string;
  name: string;
  createdBy: string;
  imageMediaId?: string | null;
}

export interface CreateChannelDto {
  workspaceId: string;
  name: string;
  visibility?: 'public' | 'private';
}

export interface ChannelDto {
  _id?: string;
  id?: string;
  workspaceId: string;
  name: string;
  visibility?: 'public' | 'private';
  imageMediaId?: string | null;
}

export interface CreateRoleDto {
  workspaceId: string;
  name: string;
  priority: number;
  permissions: string[];
}

export interface ChannelJoinDto {
  roleName?: string;
}

export interface ChannelInviteDto {
  targetUserId: string;
  roleName?: string;
}

export interface ChannelKeyDistributionPayloadDto {
  type: 'channel_key_distribution';
  channelId: string;
  channelName?: string;
  keyVersion: number;
  encryptedChannelKey: string;
  distributionId: string;
  issuedAt: string;
  invitedBy: string;
}

export interface ChannelUpdateRoleDto {
  targetUserId: string;
  roleName: string;
}

export interface SendChannelMessageDto {
  ciphertext: string;
  nonce: string;
  keyVersion?: number;
  messageId?: string;
}

export interface ChannelMemberDto {
  id: string;
  userId: string;
  role: string;
  joinedAt: string;
}

import { apiFetch } from '$lib/utils/apiFetch';

export class ChannelService {
  private baseUrl: string;

  constructor() {
    // In browser, API routes are proxied by Vite/nginx.
    const env = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SOCIAL_URL;
    if (env) {
      this.baseUrl = env;
    } else {
      this.baseUrl = ''; // Use relative path by default to hit the gateway
    }
  }

  // Normalize channel IDs coming from the UI (`channel_<id>`) to the raw
  // backend channel id. Centralizing this avoids repeating `.replace` across
  // callers and makes the client tolerant to UI conversation keys.
  private normalizeChannelId(id: string): string {
    if (id === undefined || id === null) return '';
    return String(id).replace(/^channel_/, '');
  }

  private fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
    return apiFetch(url, init as any);
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
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/workspaces`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto>;
  }

  async getWorkspaceBySlug(slug: string) {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/by-slug/${encodeURIComponent(slug)}`
    );
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto>;
  }

  async listUserWorkspaces() {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/workspaces/user/me`);
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto[]>;
  }

  async createChannel(dto: CreateChannelDto) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async createRole(dto: CreateRoleDto) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/roles/`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async listChannels(workspaceId: string) {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspace/${workspaceId}/user/me`
    );
    await this.handleError(res);
    return res.json() as Promise<ChannelDto[]>;
  }

  async joinChannel(channelId: string, dto: ChannelJoinDto) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members/join`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async leaveChannel(channelId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members/leave`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    await this.handleError(res);
    return res.json();
  }

  async kickMember(channelId: string, targetUserId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members/kick`, {
      method: 'POST',
      body: JSON.stringify({ targetUserId }),
    });
    await this.handleError(res);
    return res.json();
  }

  async renameChannel(channelId: string, newName: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: newName }),
    });
    await this.handleError(res);
    return res.json();
  }

  async deleteChannel(channelId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}`, {
      method: 'DELETE',
    });
    await this.handleError(res);
    return res.json();
  }

  async inviteToChannel(
    channelId: string,
    dto: ChannelInviteDto
  ): Promise<{
    success: boolean;
    userId: string;
    keyDistribution?: ChannelKeyDistributionPayloadDto;
  }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members/invite`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async markKeyDistributionSent(channelId: string, distributionId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/key-distributions/${distributionId}/sent`,
      {
        method: 'POST',
      }
    );
    await this.handleError(res);
    return res.json();
  }

  async markKeyDistributionReceived(channelId: string, distributionId: string, keyVersion: number) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/key-distributions/${distributionId}/received`,
      {
        method: 'POST',
        body: JSON.stringify({ keyVersion }),
      }
    );
    await this.handleError(res);
    return res.json();
  }

  async ackKeyDistribution(channelId: string, distributionId: string, keyVersion: number) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/key-distributions/${distributionId}/ack`,
      {
        method: 'POST',
        body: JSON.stringify({ keyVersion }),
      }
    );
    await this.handleError(res);
    return res.json();
  }

  async updateMemberRole(channelId: string, dto: ChannelUpdateRoleDto) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members/role`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async sendMessage(channelId: string, dto: SendChannelMessageDto) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/messages`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json();
  }

  async listMessages(channelId: string, limit = 100) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages?limit=${limit}`
    );
    await this.handleError(res);
    return res.json();
  }

  async listMembers(channelId: string): Promise<ChannelMemberDto[]> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members`);
    await this.handleError(res);
    return res.json();
  }

  async rotateChannelKey(channelId: string): Promise<{ channelId: string; keyVersion: number }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/key/rotate`, {
      method: 'POST',
    });
    await this.handleError(res);
    return res.json();
  }

  async updateChannelImage(channelId: string, mediaId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/image`, {
      method: 'PATCH',
      body: JSON.stringify({ mediaId }),
    });
    await this.handleError(res);
    return res.json() as Promise<{ success: boolean; channelId: string; imageMediaId: string }>;
  }

  async updateWorkspaceImage(workspaceId: string, mediaId: string) {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/image`,
      {
        method: 'PATCH',
        body: JSON.stringify({ mediaId }),
      }
    );
    await this.handleError(res);
    return res.json() as Promise<{ success: boolean; workspaceId: string; imageMediaId: string }>;
  }
}

export const channelService = new ChannelService();
