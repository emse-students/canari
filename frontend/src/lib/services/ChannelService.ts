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
  keyVersion?: number;
  keyBootstrap?: ChannelBootstrapDto;
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

export interface CreateChannelResultDto extends ChannelDto {
  keyVersion?: number;
  keyBootstrap?: ChannelBootstrapDto;
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
  epochKeys?: Array<{
    keyVersion: number;
    encryptedChannelKey: string;
  }>;
  distributionId: string;
  issuedAt: string;
  invitedBy: string;
}

export interface ChannelUpdateRoleDto {
  targetUserId: string;
  roleName: string;
}

/**
 * Label-free poll descriptor sent alongside the encrypted poll message.
 * Only opaque option IDs and timing reach the server; labels stay in `ciphertext`.
 */
export interface ChannelPollInput {
  optionIds: string[];
  multipleChoice?: boolean;
  endsAt?: string | null;
}

export interface SendChannelMessageDto {
  ciphertext: string;
  nonce: string;
  keyVersion?: number;
  messageId?: string;
  /** When set, the message is a poll: auto-pinned server-side and votable. */
  poll?: ChannelPollInput;
}

/** Server-visible poll state (no labels) carried on a channel message. */
export interface ChannelPollMeta {
  optionIds: string[];
  multipleChoice: boolean;
  endsAt: string | null;
  /** userId -> selected optionIds. */
  votesByUser: Record<string, string[]>;
}

/**
 * Decrypted poll definition embedded in the message plaintext. The labels never
 * leave the client unencrypted; only the matching {@link ChannelPollMeta.optionIds}
 * are visible to the server.
 */
export interface ChannelPollSpec {
  kind: 'poll';
  question: string;
  options: { id: string; label: string }[];
  multipleChoice?: boolean;
  endsAt?: string | null;
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

  /** Creates a shareable invite-link token for a community. */
  async createWorkspaceInvite(
    workspaceId: string,
    opts?: { expiresAt?: string | null; maxUses?: number | null }
  ): Promise<{ token: string }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/invites`,
      { method: 'POST', body: JSON.stringify(opts ?? {}) }
    );
    await this.handleError(res);
    return res.json() as Promise<{ token: string }>;
  }

  /** Previews an invite link (community name/image) before joining. */
  async getInvitePreview(token: string): Promise<{
    valid: boolean;
    workspaceName: string | null;
    workspaceSlug: string | null;
    imageMediaId: string | null;
  }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/invites/${encodeURIComponent(token)}`
    );
    await this.handleError(res);
    return res.json();
  }

  /** Joins the calling user into the community behind an invite link. */
  async acceptInvite(token: string): Promise<{ workspaceSlug: string; alreadyMember: boolean }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/invites/${encodeURIComponent(token)}/accept`,
      { method: 'POST' }
    );
    await this.handleError(res);
    return res.json() as Promise<{ workspaceSlug: string; alreadyMember: boolean }>;
  }

  async createChannel(dto: CreateChannelDto): Promise<CreateChannelResultDto> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
    await this.handleError(res);
    return res.json() as Promise<CreateChannelResultDto>;
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

  async getChannelKeyBootstrap(channelId: string): Promise<ChannelBootstrapDto> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/key`);
    await this.handleError(res);
    return res.json() as Promise<ChannelBootstrapDto>;
  }

  async getChannelHistoryKeys(channelId: string): Promise<ChannelHistoryKeysDto> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/keys/history`);
    await this.handleError(res);
    return res.json() as Promise<ChannelHistoryKeysDto>;
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

  async leaveWorkspace(workspaceId: string) {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${workspaceId}/leave`,
      { method: 'POST' }
    );
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

  /**
   * Broadcasts an ephemeral typing signal to channel members. Fire-and-forget:
   * typing is non-critical, so failures are swallowed rather than surfaced.
   */
  async sendTyping(channelId: string, isTyping: boolean): Promise<void> {
    try {
      const cid = this.normalizeChannelId(channelId);
      await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/typing`, {
        method: 'POST',
        body: JSON.stringify({ typing: isTyping }),
      });
    } catch {
      // Non-critical - ignore.
    }
  }

  /** Pins or unpins a channel message (broadcasts a channel.pin event server-side). */
  async setMessagePinned(channelId: string, messageId: string, pinned: boolean): Promise<void> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages/${encodeURIComponent(messageId)}/pin`,
      { method: 'POST', body: JSON.stringify({ pinned }) }
    );
    await this.handleError(res);
  }

  /** Records the caller's vote on a poll message (empty optionIds retracts). Returns the updated tally. */
  async votePoll(
    channelId: string,
    messageId: string,
    optionIds: string[]
  ): Promise<ChannelPollMeta> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages/${encodeURIComponent(messageId)}/poll/vote`,
      { method: 'POST', body: JSON.stringify({ optionIds }) }
    );
    await this.handleError(res);
    return res.json() as Promise<ChannelPollMeta>;
  }

  /** Returns the IDs of the pinned messages in a channel. */
  async listPinnedMessageIds(channelId: string): Promise<string[]> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/pins`);
    await this.handleError(res);
    return res.json() as Promise<string[]>;
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

  async getChannelAccess(channelId: string): Promise<{
    channelId: string;
    isPrivate: boolean;
    allowedUsers: string[];
  }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/access`);
    await this.handleError(res);
    return res.json();
  }

  async updateChannelAccess(
    channelId: string,
    isPrivate: boolean,
    allowedUserIds: string[]
  ): Promise<{ ok: boolean }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/access`, {
      method: 'PATCH',
      body: JSON.stringify({ isPrivate, allowedUserIds }),
    });
    await this.handleError(res);
    return res.json();
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
