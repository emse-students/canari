import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import type { DistributionScope } from '$lib/mls-client/distributionScope';

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
  /**
   * What this community lets a newcomer read: `shared` (the past) or `joined` (nothing older).
   *
   * Typed as a plain string because it comes off the wire: the client narrows it once, where it is
   * stored, rather than trusting the server to have sent one of two words.
   */
  historyVisibility?: string;
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
  /**
   * Whether the viewer may actually READ this salon, as opposed to merely seeing that it exists.
   *
   * False only ever appears on a private salon an administrator has not joined - the row that makes
   * the join reachable. Optional because the routes that create a channel answer with the row they
   * just wrote, where the question does not arise: absent means "yes", never "unknown".
   */
  viewerHasAccess?: boolean;
  /**
   * Whether the viewer may POST here, as the server decided it - `writePolicy` applied to the
   * viewer's own roles in this community.
   *
   * The policy itself is deliberately NOT carried: a client holds no roles to apply it to, so it
   * would need a second copy of the rule and half of its inputs. Optional for the same reason as
   * `viewerHasAccess` - the create routes answer with the row they just wrote - and absent means
   * "yes", which is also the server's default policy.
   */
  viewerCanWrite?: boolean;
}

export type CreateChannelResultDto = ChannelDto;

export interface ChannelJoinDto {
  roleName?: string;
}

export interface ChannelInviteDto {
  targetUserId: string;
  roleName?: string;
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
  /** The Graine session this message was sealed under, and which of its message keys. */
  senderSessionId: string;
  messageIndex: number;
  messageId?: string;
  /** When set, the message is a poll: auto-pinned server-side and votable. */
  poll?: ChannelPollInput;
  /**
   * Cleartext list of mentioned user ids, attached so the server can route the `mentions`
   * notification level without decrypting. Exposes WHO is mentioned (never the content).
   */
  mentionedUserIds?: string[];
  /** True for a message that must never notify - a reaction. The server pushes nothing for it. */
  silent?: boolean;
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
 * encrypted: `ciphertext`/`nonce` are opened client-side with the Graine seed named by
 * `senderSessionId` at `messageIndex` - the server holds neither. `poll` carries the label-free
 * tally so results render without opening anything.
 */
export interface ChannelMessageRow {
  id: string;
  channelId: string;
  senderId: string;
  ciphertext: string;
  nonce: string | null;
  /** The sender's Graine session, and which of its message keys. Null only on a pre-Graine row. */
  senderSessionId: string | null;
  messageIndex: number | null;
  replyTo: string | null;
  createdAt: string;
  pinned: boolean;
  poll: ChannelPollMeta | null;
  /**
   * True for a row that must never notify - a reaction (WP-40).
   *
   * The only thing the server knows about a body it cannot read. It does NOT say what the row is:
   * the client decodes it like any other, and a reaction frame is routed to the reaction store.
   */
  silent?: boolean;
}

import { apiFetch } from '$lib/utils/apiFetch';
import { Log } from '$lib/utils/Log';

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
   * The base URL of one scope's distribution-group routes.
   *
   * TWO ROUTES, ONE SPELLING. A community's group hangs off the community and a private salon's off
   * the salon, and the two are authorized by different facts - community membership on one side,
   * `canAccessChannel` on the other. Built here so a caller cannot pick the wrong one by
   * concatenating a path, which is the mistake that would hand a salon's caller the community's
   * group and undo the whole point of the salon scope.
   */
  private distributionGroupUrl(scope: DistributionScope): string {
    return scope.kind === 'workspace'
      ? `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(scope.workspaceId)}/distribution-group`
      : `${this.baseUrl}/api/channels/${encodeURIComponent(scope.channelId)}/distribution-group`;
  }

  /**
   * Where each named Graine session becomes readable for ONE member of the channel's community.
   *
   * Asked by the device about to HAND A SEED OVER, under a community that closes its past, and
   * answered from two columns only the server holds: that member's arrival row and the message
   * dates. A session absent from the answer has nothing that member may read and must be withheld
   * whole - which is why absence, not a zero, is what carries it.
   *
   * The reason this is a server call rather than a comparison: a Graine session can SPAN an
   * arrival, so neither withholding it nor handing it over is right, and only the message rows say
   * where the line falls. See `docs/wiki/protocols/channel-encryption.md`.
   *
   * @param channelId Channel the sessions belong to.
   * @param forUserId Whose arrival draws the floor.
   * @param sessionIds Sessions the repair request named.
   * @returns `sessionId -> lowest readable index`, omitting sessions with nothing readable.
   */
  async graineHistoryFloor(
    channelId: string,
    forUserId: string,
    sessionIds: string[]
  ): Promise<Record<string, number>> {
    const query = new URLSearchParams({ forUser: forUserId, sessions: sessionIds.join(',') });
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/${encodeURIComponent(channelId)}/graine/history-floor?${query}`
    );
    await this.handleError(res);
    return res.json() as Promise<Record<string, number>>;
  }

  /**
   * A scope's Graine key-distribution group, and the latest GroupInfo published on it.
   *
   * Served by social-service rather than chat-delivery, and that is not an arbitrary placement: the
   * GroupInfo IS the capability to enter this group and read every seed on it, so the answer is
   * authorized by membership of the scope - a fact only social-service holds. See
   * `docs/wiki/protocols/channel-encryption.md`.
   *
   * `groupInfo: null` means the MLS group has not been initialised yet. The caller seeing it is the
   * first member in and is the one that creates it - a state to act on, never an error. A scope
   * with no group at all is a `ChannelApiError` carrying `WORKSPACE_HAS_NO_DISTRIBUTION_GROUP` or
   * `CHANNEL_HAS_NO_DISTRIBUTION_GROUP`, because those need a different response again.
   */
  async getDistributionGroup(scope: DistributionScope): Promise<DistributionGroupDto> {
    const res = await this.fetchWithAuth(this.distributionGroupUrl(scope));
    await this.handleError(res);
    return res.json() as Promise<DistributionGroupDto>;
  }

  /**
   * Publishes a GroupInfo this device just committed on a scope's distribution group.
   *
   * Monotonic server-side: `{ stored: false }` means a newer base epoch is already published and
   * this one was declined, which is the mechanism working, not a failure.
   *
   * `deviceId` is not bookkeeping: publishing is how the device that CREATED the MLS group gets
   * into the group's delivery roster. Nothing else ever would - the roster is written by the commit
   * fan-out and a creator sends no commit - so without it the creator receives nothing on its own
   * distribution group. See the transport contract in `IMlsService.ts`.
   */
  async publishDistributionGroupInfo(
    scope: DistributionScope,
    groupInfoBase64: string,
    baseEpoch: number,
    deviceId: string
  ): Promise<{ stored: boolean }> {
    const res = await this.fetchWithAuth(`${this.distributionGroupUrl(scope)}/group-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupInfo: groupInfoBase64, baseEpoch, deviceId }),
    });
    await this.handleError(res);
    return res.json() as Promise<{ stored: boolean }>;
  }

  /**
   * Puts the calling administrator into a private salon they can see but cannot read.
   *
   * The capability an admin has instead of a bypass: `workspace.manage` shows them the salon
   * EXISTS, and this is how they enter it - visibly, in its member list, and with no system message
   * in the transcript. Until they call it, no route hands them the salon's GroupInfo, which is what
   * keeps the salon's MLS roster finite.
   */
  async joinPrivateChannelAsAdmin(
    channelId: string
  ): Promise<{ success: boolean; alreadyMember: boolean }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/join-as-admin`, {
      method: 'POST',
    });
    await this.handleError(res);
    return res.json() as Promise<{ success: boolean; alreadyMember: boolean }>;
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
   * Deletes a whole community for every member, irreversibly (admin-only, MANAGE_WORKSPACE).
   * The server broadcasts `workspace.deleted`, so other connected members clean up
   * without polling.
   *
   * `confirmationName` must be the community's name, and the server refuses the call when it does
   * not match. Passing it is not optional politeness: the check exists precisely so that a client
   * which does not send it cannot destroy anything.
   */
  async deleteWorkspace(workspaceId: string, confirmationName: string) {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/workspaces/${workspaceId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmationName }),
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
  ): Promise<{ success: boolean; userId: string }> {
    const cid = this.normalizeChannelId(channelId);
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/${cid}/members/invite`, {
      method: 'POST',
      body: JSON.stringify(dto),
    });
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
      Log.d('CHANNEL_READ', `signalled ${cid.slice(0, 8)} to this account's other devices`);
    } catch (e) {
      // Best-effort, and said out loud anyway - at a level that ACCUSES. The only symptom of a loss
      // here is a notification still sitting on a phone in somebody's pocket, and nothing else in
      // the system will ever report that.
      console.warn(
        `[CHANNEL_READ] could not signal ${cid.slice(0, 8)} - a stale notification may linger on ` +
          `another device: ${e instanceof Error ? e.message : String(e)}`
      );
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

  /**
   * The whole community roster, for a caller that holds no channel id.
   *
   * Used by the Graine layer at join time, when no salon has been opened yet and the device still
   * has to name the one member it will ask for history.
   */
  async listWorkspaceMembers(workspaceId: string): Promise<ChannelMemberDto[]> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/members`
    );
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

  /**
   * Grants or revokes ONE permission on a role, and returns the role's whole list as the server
   * holds it AFTERWARDS.
   *
   * SENT AS THE DELTA IT IS. `setRolePermissions` below sends the list this browser computed, so two
   * administrators toggling two different cells of one role at the same moment lose one of the two
   * edits - measured on production by COMM-20 on 2026-08-20. The answer is authoritative and must be
   * applied as such: it already carries anything somebody else changed in the meantime.
   */
  async setRolePermission(
    roleId: string,
    key: string,
    granted: boolean
  ): Promise<{
    roleId: string;
    roleName: string;
    permissions: string[];
  }> {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/roles/${encodeURIComponent(roleId)}/permissions`,
      {
        method: 'PATCH',
        body: JSON.stringify({ key, granted }),
      }
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

  /**
   * Sets what the community lets a newcomer read.
   *
   * The server stores and broadcasts the value; it cannot enforce it and holds no seed. The rule is
   * applied by whichever member answers a joiner's history request - see
   * `docs/wiki/protocols/channel-encryption.md`.
   */
  async updateWorkspaceHistoryVisibility(
    workspaceId: string,
    historyVisibility: GraineHistoryVisibility
  ) {
    const res = await this.fetchWithAuth(
      `${this.baseUrl}/api/channels/workspaces/${encodeURIComponent(workspaceId)}/history-visibility`,
      {
        method: 'PATCH',
        body: JSON.stringify({ historyVisibility }),
      }
    );
    await this.handleError(res);
    return res.json() as Promise<{
      success: boolean;
      workspaceId: string;
      historyVisibility: GraineHistoryVisibility;
    }>;
  }

  /**
   * Of the Graine sessions this device holds, which ones the server still has messages for.
   *
   * The retention sweep's one question. `retentionDays` comes back with the answer so the client
   * never compiles in a copy of the window - the server owns that number, and the device needs it
   * only to refuse dropping a session too young to have lost anything.
   *
   * @param sessionIds At most 500; the server REFUSES a longer list rather than truncating it,
   *   because a truncated answer would read as "the rest are dead" and cost live seeds.
   */
  async liveGraineSessions(
    sessionIds: string[]
  ): Promise<{ live: string[]; retentionDays: number }> {
    const res = await this.fetchWithAuth(`${this.baseUrl}/api/channels/graine/live-sessions`, {
      method: 'POST',
      body: JSON.stringify({ sessionIds }),
    });
    await this.handleError(res);
    return res.json() as Promise<{ live: string[]; retentionDays: number }>;
  }
}

export const channelService = new ChannelService();
