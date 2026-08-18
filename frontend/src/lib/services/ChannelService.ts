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
  /** Server-authoritative flag: true when the calling user holds MANAGE_WORKSPACE in this workspace. Drives admin-control gating in the UI. */
  viewerCanManage?: boolean;
  /** Server-authoritative flag: true when the calling user holds `channel.moderate` (or a permission that subsumes it), i.e. may delete other members' channel messages. */
  viewerCanModerate?: boolean;
}

/**
 * What `GET /workspaces/by-slug/:slug` actually returns: the workspace plus everything hanging off
 * it. Typed here because the endpoint does NOT return a bare {@link WorkspaceDto}, and the two call
 * sites were each casting it back to a hand-written shape.
 */
export interface WorkspaceDetailDto {
  workspace: WorkspaceDto;
  channels: ChannelDto[];
  members: Array<{ userId: string; roleIds?: string[] }>;
  roles: Array<{ id: string; name: string; priority?: number; permissions?: string[] }>;
}

/**
 * A community's ONE live invite link. The bounds travel with the token because a link a human can
 * reason about has to show what bounds it - a token alone cannot say whether it expires.
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

/**
 * A community's Graine key-distribution group as social-service serves it.
 *
 * `groupInfo` and `baseEpoch` are null together, and only together: the group row exists but no
 * client has initialised the MLS group yet.
 */
export interface DistributionGroupDto {
  /** The MLS group id, in chat-delivery's `dm_groups`. Stable for the life of the community. */
  groupId: string;
  /** Serialized MLS GroupInfo (base64) to external-join from, or null when none is published. */
  groupInfo: string | null;
  /** The epoch `groupInfo` was exported at, or null when `groupInfo` is. */
  baseEpoch: number | null;
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
  /**
   * Cleartext list of mentioned user ids, attached so the server can route the `mentions`
   * notification level without decrypting. Exposes WHO is mentioned (never the content).
   */
  mentionedUserIds?: string[];
}

/** Per-channel push notification level a member can set for themselves. */
export type ChannelNotificationLevel = 'all' | 'mentions' | 'none';

/** Who may post in a channel: everyone, admins + moderators, or admins only. */
export type ChannelWritePolicy = 'everyone' | 'admins_moderators' | 'admins';

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

/**
 * A channel message row as returned by the messages API (newest-first). The payload stays
 * encrypted: `ciphertext`/`nonce`/`keyVersion` are decrypted client-side with the channel epoch
 * key. `poll` carries the label-free tally so results render without decrypting.
 */
export interface ChannelMessageRow {
  id: string;
  channelId: string;
  senderId: string;
  ciphertext: string;
  nonce: string | null;
  keyVersion: number | null;
  replyTo: string | null;
  createdAt: string;
  pinned: boolean;
  poll: ChannelPollMeta | null;
  /** Cleartext reaction tally, `emoji -> userIds`. Absent on rows predating the feature. */
  reactions?: Record<string, string[]>;
}

import { apiFetch } from '$lib/utils/apiFetch';

/**
 * A refusal answered by the channels API.
 *
 * Carries the HTTP status and the server's stable `code` so callers classify by TYPE and by a
 * machine-readable discriminator, never by the sentence in `message` - which stays the raw response
 * body so existing consumers that surface it are unchanged. The `code` half is the same contract
 * `DEVICE_REVOKED` uses on the delivery service.
 */
export class ChannelApiError extends Error {
  constructor(
    /** The HTTP status the server answered with. */
    readonly status: number,
    /** The server's stable error code, or null when the body carried none. */
    readonly code: string | null,
    message: string
  ) {
    super(message);
    this.name = 'ChannelApiError';
  }
}

/**
 * Reads the stable `code` a Nest exception body carries.
 * Returns null when the body is not JSON, or is JSON without a `code` - both meaning "this refusal
 * has no machine-readable name", which callers must treat as unclassified rather than as a match.
 */
function readErrorCode(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return null;
    const code = (parsed as { code?: unknown }).code;
    return typeof code === 'string' && code ? code : null;
  } catch {
    return null;
  }
}

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
        // An HTML body is nginx answering, not the service: there is no `code` to read.
        throw new ChannelApiError(
          res.status,
          null,
          `API Error ${res.status}: Le service est injoignable (Bad Gateway). Veuillez réessayer plus tard.`
        );
      }
      throw new ChannelApiError(res.status, readErrorCode(text), text || `API Error ${res.status}`);
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

  /**
   * Full detail for one community. Note the shape is NOT a bare {@link WorkspaceDto}: the endpoint
   * nests the workspace alongside its channels, members and roles.
   */
  async getWorkspaceBySlug(slug: string): Promise<WorkspaceDetailDto> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/by-slug/${encodeURIComponent(slug)}`
    );
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDetailDto>;
  }

  /**
   * The community's Graine key-distribution group, and the latest GroupInfo published on it.
   *
   * Served by social-service rather than chat-delivery, and that is not an arbitrary placement: the
   * GroupInfo IS the capability to enter this group and read every seed on it, so the answer is
   * authorized by COMMUNITY membership - a fact only social-service holds. See
   * `docs/wiki/protocols/channel-encryption.md`.
   *
   * `groupInfo: null` means the MLS group has not been initialised yet. The caller seeing it is the
   * first member in and is the one that creates it - a state to act on, never an error. A community
   * with no group at all is a `ChannelApiError` carrying `WORKSPACE_HAS_NO_DISTRIBUTION_GROUP`,
   * because those two need opposite responses.
   */
  async getDistributionGroup(workspaceId: string): Promise<DistributionGroupDto> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/distribution-group`
    );
    await this.handleError(res);
    return res.json() as Promise<DistributionGroupDto>;
  }

  /**
   * Publishes a GroupInfo this device just committed on the community's distribution group.
   *
   * Monotonic server-side: `{ stored: false }` means a newer base epoch is already published and
   * this one was declined, which is the mechanism working, not a failure.
   */
  async publishDistributionGroupInfo(
    workspaceId: string,
    groupInfoBase64: string,
    baseEpoch: number
  ): Promise<{ stored: boolean }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/distribution-group/group-info`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupInfo: groupInfoBase64, baseEpoch }),
      }
    );
    await this.handleError(res);
    return res.json() as Promise<{ stored: boolean }>;
  }

  async listUserWorkspaces() {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/workspaces/user/me`);
    await this.handleError(res);
    return res.json() as Promise<WorkspaceDto[]>;
  }

  /** Persists the caller's personal top-to-bottom order for their communities. */
  async reorderWorkspaces(orderedIds: string[]): Promise<void> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/workspaces/reorder`, {
      method: 'PATCH',
      body: JSON.stringify({ orderedIds }),
    });
    await this.handleError(res);
  }

  /**
   * Returns the community's one live invite link, minting it if there is none.
   *
   * `rotate` is the only way to get a new token: it revokes the live one and mints its
   * replacement. Without it the existing link comes back unchanged, so opening the panel can never
   * silently invalidate a link somebody has already shared.
   */
  async createWorkspaceInvite(
    workspaceId: string,
    opts?: { expiresAt?: string | null; maxUses?: number | null; rotate?: boolean }
  ): Promise<WorkspaceInviteDto> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/invites`,
      { method: 'POST', body: JSON.stringify(opts ?? {}) }
    );
    await this.handleError(res);
    return res.json() as Promise<WorkspaceInviteDto>;
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

  /**
   * Leaves a PRIVATE channel. A public channel is readable by every member of the community and
   * holds no per-member access, so the server refuses it with a 400 - leaving is `leaveWorkspace`
   * there, and the settings panel only offers this on a private channel.
   */
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

  /**
   * Soft-deletes a whole community for every member (admin-only, MANAGE_WORKSPACE).
   * The server broadcasts `workspace.deleted`, so other connected members clean up
   * without polling.
   */
  async deleteWorkspace(workspaceId: string) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/workspaces/${workspaceId}`, {
      method: 'DELETE',
    });
    await this.handleError(res);
    return res.json();
  }

  async kickFromWorkspace(workspaceId: string, targetUserId: string) {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(targetUserId)}`,
      { method: 'DELETE' }
    );
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

  /**
   * Deletes a channel message. The server allows the author unconditionally and anyone holding
   * `channel.moderate` for someone else's message, then broadcasts `channel.message.deleted`.
   */
  async deleteChannelMessage(channelId: string, messageId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages/${messageId}`,
      { method: 'DELETE' }
    );
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

  async removeMemberFromChannel(channelId: string, userId: string) {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/members/${encodeURIComponent(userId)}`,
      {
        method: 'DELETE',
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

  /** Returns the caller's push notification level for a channel (`all` when never set). */
  async getNotificationLevel(channelId: string): Promise<ChannelNotificationLevel> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/notification-level`);
    await this.handleError(res);
    const body = (await res.json()) as { level: ChannelNotificationLevel };
    return body.level;
  }

  /** Sets the caller's push notification level for a channel (`all` | `mentions` | `none`). */
  async setNotificationLevel(
    channelId: string,
    level: ChannelNotificationLevel
  ): Promise<ChannelNotificationLevel> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/notification-level`, {
      method: 'PATCH',
      body: JSON.stringify({ level }),
    });
    await this.handleError(res);
    const body = (await res.json()) as { level: ChannelNotificationLevel };
    return body.level;
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

  /** Closes a poll now (author or moderator only). Returns the poll tally with its forced deadline. */
  async closePoll(channelId: string, messageId: string): Promise<ChannelPollMeta> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages/${encodeURIComponent(messageId)}/poll/close`,
      { method: 'PATCH' }
    );
    await this.handleError(res);
    return res.json() as Promise<ChannelPollMeta>;
  }

  /**
   * Toggles the caller's emoji reaction on a channel message. Returns the new authoritative
   * tally (`emoji -> userIds`); the server also broadcasts `channel.reaction` to every member.
   */
  async toggleReaction(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<Record<string, string[]>> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages/${encodeURIComponent(messageId)}/reactions`,
      { method: 'POST', body: JSON.stringify({ emoji }) }
    );
    await this.handleError(res);
    return res.json() as Promise<Record<string, string[]>>;
  }

  /** Returns the IDs of the pinned messages in a channel. */
  async listPinnedMessageIds(channelId: string): Promise<string[]> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/pins`);
    await this.handleError(res);
    return res.json() as Promise<string[]>;
  }

  /**
   * Signals that the caller has read this channel, so the server pushes a silent `channel_read`
   * to the caller's other devices to clear the channel's notification (cross-device read-state
   * sync). Best-effort and fire-and-forget: read state is not critical enough to surface errors.
   */
  async markChannelRead(channelId: string): Promise<void> {
    const cid = this.normalizeChannelId(channelId);
    try {
      await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/read`, { method: 'POST' });
    } catch {
      /* best-effort: a failed read signal only means a stale notification lingers elsewhere */
    }
  }

  /**
   * Fetches a single page of channel messages (newest-first). When `before` (ISO timestamp) is
   * set, only messages strictly older than it are returned - the keyset cursor used to page back
   * through history.
   */
  async listMessages(
    channelId: string,
    limit = 100,
    before?: string
  ): Promise<ChannelMessageRow[]> {
    const cid = this.normalizeChannelId(channelId);
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${cid}/messages?${params.toString()}`
    );
    await this.handleError(res);
    return res.json();
  }

  /**
   * Pages back through a channel's entire history (newest-first), following the `createdAt` keyset
   * cursor until the server returns an empty page or `cap` messages have been collected. Used by
   * full-text channel search, which must look beyond the most recent page. The cap bounds memory
   * and request count on very large channels; `capped` signals the history was truncated.
   */
  async fetchAllChannelMessages(
    channelId: string,
    opts: { cap?: number; pageSize?: number } = {}
  ): Promise<{ rows: ChannelMessageRow[]; capped: boolean }> {
    const cap = opts.cap ?? 2000;
    const pageSize = Math.min(opts.pageSize ?? 200, 200);
    const rows: ChannelMessageRow[] = [];
    let before: string | undefined;

    while (rows.length < cap) {
      const page = await this.listMessages(channelId, pageSize, before);
      if (!Array.isArray(page) || page.length === 0) break;
      rows.push(...page);
      const oldest = page[page.length - 1]?.createdAt;
      // Server returns strictly-older messages, so passing the oldest createdAt never re-fetches
      // the same row; a short final page means history is exhausted.
      if (!oldest || page.length < pageSize) break;
      before = typeof oldest === 'string' ? oldest : new Date(oldest).toISOString();
    }

    return { rows: rows.slice(0, cap), capped: rows.length >= cap };
  }

  /**
   * Lists the channel's own members. Pass `scope: 'workspace'` for the whole community roster -
   * a private channel otherwise answers only the people who may actually read it.
   */
  async listMembers(
    channelId: string,
    scope: 'channel' | 'workspace' = 'channel'
  ): Promise<ChannelMemberDto[]> {
    const cid = this.normalizeChannelId(channelId);
    const query = scope === 'workspace' ? '?scope=workspace' : '';
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members${query}`);
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

  async getChannelAccess(channelId: string): Promise<{
    channelId: string;
    isPrivate: boolean;
    allowedUsers: string[];
    writePolicy: ChannelWritePolicy;
  }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/access`);
    await this.handleError(res);
    return res.json();
  }

  async updateChannelAccess(
    channelId: string,
    isPrivate: boolean,
    allowedUserIds: string[],
    writePolicy?: ChannelWritePolicy
  ): Promise<{ ok: boolean; writePolicy?: ChannelWritePolicy }> {
    const cid = this.normalizeChannelId(channelId);
    const body: Record<string, unknown> = { isPrivate, allowedUserIds };
    if (writePolicy) {
      body.writePolicy = writePolicy;
    }
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/access`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    await this.handleError(res);
    return res.json();
  }

  /** Sets a workspace member's role (workspace-level; requires MANAGE_WORKSPACE or MANAGE_ROLES). */
  async updateWorkspaceMemberRole(
    workspaceId: string,
    userId: string,
    roleName: string
  ): Promise<{ success: boolean }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(userId)}/role`,
      {
        method: 'PATCH',
        body: JSON.stringify({ roleName }),
      }
    );
    await this.handleError(res);
    return res.json();
  }

  async getRolePermissions(roleId: string): Promise<{
    roleId: string;
    roleName: string;
    permissions: string[];
  }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/roles/${encodeURIComponent(roleId)}/permissions`
    );
    await this.handleError(res);
    return res.json();
  }

  async setRolePermissions(
    roleId: string,
    permissions: string[]
  ): Promise<{
    roleId: string;
    roleName: string;
    permissions: string[];
  }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/roles/${encodeURIComponent(roleId)}/permissions`,
      {
        method: 'PUT',
        body: JSON.stringify({ permissions }),
      }
    );
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
