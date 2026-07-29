import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ChannelService } from '$lib/services/ChannelService';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import type { IMlsService } from '$lib/mlsService';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { mkChannelInviteSentEnvelope, serializeEnvelope } from '$lib/envelope';
import {
  hydrateChannelBootstrap,
  isChannelConversationId,
  sendEncryptedChannelMessage,
} from '$lib/utils/chat/channelCrypto';
import { currentUserId } from '$lib/stores/userState.svelte';
import { applyLocalChannelReaction, setChannelReactions } from '$lib/stores/reactionStore.svelte';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { resolveDisplayNames } from '$lib/utils/users/displayName';

/** One channel entry shown in the sidebar under its workspace. */
export interface ChannelSidebarItem {
  /** Conversation ID, prefixed with "channel_". */
  id: string;
  /** Display name of the channel (e.g. "general"). */
  name: string;
  /** Number of messages not yet read by the current user. */
  unreadCount?: number;
  /** True for private channels that require an explicit invitation. */
  isPrivate?: boolean;
}

/** One workspace (community) shown in the sidebar, containing its channels. */
export interface ChannelSidebarWorkspace {
  /** URL slug used as the local identifier (e.g. "emse-mine"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** MongoDB _id from the backend - may be absent until the first API sync. */
  workspaceDbId?: string;
  /** Seed for the avatar image fallback (usually the workspace name). */
  avatarUserId: string;
  /** media-service ID of the workspace cover image, if set. */
  imageMediaId?: string | null;
  /** Server-authoritative: true when the current user may manage this workspace (MANAGE_WORKSPACE). Gates admin controls. Defaults to false until the backend listing confirms it. */
  viewerCanManage?: boolean;
  /** Server-authoritative: true when the current user holds `channel.moderate` (or a permission that subsumes it) here, letting them delete other members' channel messages. */
  viewerCanModerate?: boolean;
  /** Ordered list of channels belonging to this workspace. */
  channels: ChannelSidebarItem[];
}

/** Runtime dependencies injected by the parent composable into workspace/channel operations. */
export interface ChannelWorkspaceContext {
  /** Reactive map of all open conversations (DMs + channels), keyed by conversation ID. */
  conversations: SvelteMap<string, Conversation>;
  /** Persists a conversation to IndexedDB. */
  saveConversation: (id: string) => Promise<void>;
  /** Removes a conversation from IndexedDB (optional - skipped during boot). */
  deleteConversation?: (id: string) => Promise<void>;
  /** Selects a conversation in the UI. */
  selectConversation: (id: string) => void;
  /** Returns (or lazily initialises) the MLS service instance - required for key distribution. */
  ensureMls?: () => IMlsService | Promise<IMlsService>;
  /** Opens (or creates) a direct MLS conversation with the given user. Pass { silent: true } to skip UI selection (e.g. background key distribution). */
  startDirectConversation?: (targetUserId: string, opts?: { silent?: boolean }) => Promise<void>;
  /** Returns the conversation ID currently visible in the chat panel. */
  getSelectedConversationId?: () => string | null;
  /**
   * Appends a message to a conversation (reactive state + IndexedDB). Needed for local echoes of
   * events MLS cannot replay to their own author - see the invite card in
   * {@link inviteMemberToChannel}. Optional: background contexts have no messaging layer.
   */
  addMessageToChat?: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  /** Refetch channel messages from the server (in-memory only). */
  reloadChannelHistory?: (channelConversationId: string) => Promise<void>;
  /** Drops cached channel history so the next open refetches from the API. */
  invalidateChannelHistoryCache?: (channelConversationId: string) => void;
  /** Appends a message to the debug log panel. */
  log: (msg: string) => void;
}

/**
 * The subset of {@link ChannelWorkspaceContext} needed to erase a community from local state.
 * Kept narrow so the background event handler - which has no conversation-selection or
 * persistence helpers on hand - can call the same purge as the UI paths.
 */
export type WorkspacePurgeContext = Pick<
  ChannelWorkspaceContext,
  'conversations' | 'deleteConversation' | 'invalidateChannelHistoryCache' | 'log'
>;

/** Creates and returns the reactive channel/workspace store: sidebar state, API operations (create, rename, delete, invite, leave, image update), and real-time event handlers. */
export function useChannelWorkspaces() {
  let channelWorkspaces = $state<ChannelSidebarWorkspace[]>([]);
  let selectedChannelConversationId = $state('');
  let isLoadingWorkspaces = false;

  const service = new ChannelService();

  /**
   * Extracts an HTTP status code and a human-readable detail from a raw API error body.
   * Handles NestJS JSON error envelopes ({ statusCode, message }) and plain-text bodies,
   * so callers can distinguish 401 (session) from 403 (permission) and surface the real reason.
   */
  function parseApiError(raw: string): { status?: number; detail: string } {
    try {
      const body = JSON.parse(raw) as {
        statusCode?: number;
        message?: string | string[];
        error?: string;
      };
      const detail = Array.isArray(body.message)
        ? body.message.join(', ')
        : (body.message ?? body.error ?? raw);
      return { status: body.statusCode, detail };
    } catch {
      const match = raw.match(/\b(4\d\d|5\d\d)\b/);
      return { status: match ? Number(match[1]) : undefined, detail: raw };
    }
  }

  /**
   * Maps a raw API error to a localized, user-facing message for `action`, surfaces it as an
   * error toast (so users no longer need the debug log to see failures), and returns the same
   * string for `ctx.log`. A 403 is reported as insufficient permissions with the backend reason,
   * distinct from a 401 which is reported as an expired session.
   * @param action Localized action label (e.g. `m.channel_action_community_image()`).
   * @param error The caught error - an Error carrying the raw API body, or any thrown value.
   * @param toast When false, skips the toast because the caller surfaces the error itself. Defaults to true.
   */
  function toUiActionError(action: string, error: unknown, toast = true): string {
    const raw = error instanceof Error ? error.message : String(error);
    const { status, detail } = parseApiError(raw);
    const hay = `${status ?? ''} ${detail}`.toLowerCase();

    let message: string;
    if (status === 401 || hay.includes('unauthorized') || hay.includes('token')) {
      message = m.channel_action_error_session({ action });
    } else if (
      status === 403 ||
      hay.includes('403') ||
      hay.includes('forbidden') ||
      hay.includes('permission')
    ) {
      message = m.channel_action_error_permission({ action, detail });
    } else if (status === 409 || hay.includes('already')) {
      message = m.channel_action_error_conflict({ action });
    } else if (
      (status !== undefined && status >= 500) ||
      hay.includes('network') ||
      hay.includes('fetch') ||
      hay.includes('injoignable')
    ) {
      message = m.channel_action_error_network({ action });
    } else {
      message = m.channel_action_error_generic({ action, detail });
    }

    if (toast) showToast(message, 'error');
    return message;
  }

  // ---------- Workspace helpers ----------

  /** Converts a workspace display name into a URL-safe slug (lowercase, ASCII, hyphens, max 48 chars). */
  function slugifyWorkspace(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

  /** Inserts a new workspace sidebar entry or updates the matching one if it already exists. Returns the sidebar entry. */
  function upsertWorkspaceFromDto(workspace: WorkspaceDto): ChannelSidebarWorkspace {
    const workspaceId = workspace.id ?? workspace._id;
    const workspaceSlug =
      workspace.slug?.trim().toLowerCase() ||
      `workspace-${workspaceId || crypto.randomUUID().slice(0, 8)}`;
    const existing = channelWorkspaces.find((item) => item.id === workspaceSlug);
    if (existing) {
      existing.workspaceDbId = workspaceId;
      existing.name = workspace.name;
      if (!existing.avatarUserId) {
        existing.avatarUserId = workspace.name || workspaceSlug;
      }
      if (workspace.imageMediaId !== undefined) existing.imageMediaId = workspace.imageMediaId;
      if (workspace.viewerCanManage !== undefined)
        existing.viewerCanManage = workspace.viewerCanManage;
      if (workspace.viewerCanModerate !== undefined)
        existing.viewerCanModerate = workspace.viewerCanModerate;
      channelWorkspaces = [...channelWorkspaces];
      return existing;
    }

    const created: ChannelSidebarWorkspace = {
      id: workspaceSlug,
      name: workspace.name,
      workspaceDbId: workspaceId,
      avatarUserId: workspace.name || workspaceSlug,
      imageMediaId: workspace.imageMediaId ?? null,
      viewerCanManage: workspace.viewerCanManage ?? false,
      viewerCanModerate: workspace.viewerCanModerate ?? false,
      channels: [],
    };
    channelWorkspaces = [...channelWorkspaces, created];
    return created;
  }

  /** Appends a channel to the sidebar entry for the given workspace slug, silently ignoring duplicates. */
  function addChannelToWorkspace(workspaceSlug: string, channel: ChannelSidebarItem) {
    const idx = channelWorkspaces.findIndex((item) => item.id === workspaceSlug);
    if (idx === -1) return;
    const workspace = channelWorkspaces[idx];
    if (workspace.channels.some((item) => item.id === channel.id)) return;

    channelWorkspaces = [
      ...channelWorkspaces.slice(0, idx),
      { ...workspace, channels: [...workspace.channels, channel] },
      ...channelWorkspaces.slice(idx + 1),
    ];
  }

  /** Removes the given channel conversation ID from every workspace in the sidebar. */
  function removeChannelFromWorkspaces(channelConversationId: string) {
    channelWorkspaces = channelWorkspaces.map((workspace) => ({
      ...workspace,
      channels: workspace.channels.filter((channel) => channel.id !== channelConversationId),
    }));
  }

  /** Returns the sidebar workspace matching the event's workspaceId/workspaceSlug, creating a placeholder entry if none exists yet. Used when a real-time channel event arrives before the full workspace list has been fetched. */
  function ensureWorkspaceForChannelEvent(event: {
    workspaceId?: string;
    workspaceSlug?: string;
    workspaceName?: string;
    imageMediaId?: string;
  }): ChannelSidebarWorkspace {
    const slugFromEvent = event.workspaceSlug?.trim().toLowerCase();
    const workspaceId = event.workspaceId;
    const workspaceName = event.workspaceName?.trim() || 'Community';

    const existing = channelWorkspaces.find(
      (workspace) =>
        (workspaceId && workspace.workspaceDbId === workspaceId) ||
        (slugFromEvent && workspace.id === slugFromEvent)
    );

    if (existing) {
      if (!existing.workspaceDbId && workspaceId) existing.workspaceDbId = workspaceId;
      if (workspaceName) {
        existing.name = workspaceName;
        if (!existing.avatarUserId) existing.avatarUserId = workspaceName;
      }
      if (event.imageMediaId !== undefined) existing.imageMediaId = event.imageMediaId;
      channelWorkspaces = [...channelWorkspaces];
      return existing;
    }

    const created: ChannelSidebarWorkspace = {
      id: slugFromEvent || `workspace-${workspaceId || crypto.randomUUID().slice(0, 8)}`,
      name: workspaceName,
      workspaceDbId: workspaceId,
      avatarUserId: workspaceName || slugFromEvent || 'workspace',
      imageMediaId: event.imageMediaId ?? null,
      channels: [],
    };
    channelWorkspaces = [...channelWorkspaces, created];
    return created;
  }

  /**
   * Hydrates the encryption key for a channel the user was just added to in-session.
   *
   * The real-time `channel.member.joined` event carries no key material (it is broadcast, so the
   * joiner's key bootstrap must never travel on it). Without this, a freshly-joined channel is
   * registered in `conversations` but has no vault key: opening it fails to decrypt every message
   * until a relaunch runs the full `loadChannelWorkspacesFromBackend` hydration. This fetches the
   * channel's current epoch bootstrap and imports it into the ChannelKeyVault so the channel is
   * usable immediately, without waiting for an app restart. Fire-and-forget; safe to call again.
   */
  async function hydrateJoinedChannelKey(channelId: string): Promise<void> {
    if (!channelId) return;
    try {
      const hydrated = await hydrateChannelBootstrap(channelId);
      console.log(
        `[CHANNEL-KEY] Hydrated key v${hydrated.keyVersion} for freshly-joined channel ${channelId}`
      );
    } catch (e) {
      console.error(
        `[CHANNEL-KEY] Failed to hydrate key for freshly-joined channel ${channelId}:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  // ---------- API operations ----------

  /**
   * Fetches all workspaces and their channels from the backend, hydrates channel encryption keys,
   * and prunes stale local channel entries.
   *
   * Resolves to false when it declined because a load was already in flight - callers that refetch
   * to resolve one specific channel (the deep-link landing) must know their request was dropped,
   * or a join racing the startup load waits forever for a refresh that never ran.
   */
  async function loadChannelWorkspacesFromBackend(ctx: ChannelWorkspaceContext): Promise<boolean> {
    if (isLoadingWorkspaces) return false;
    isLoadingWorkspaces = true;
    try {
      const backendWorkspaces = await service.listUserWorkspaces();
      const validChannelConversationIds: string[] = [];
      const validWorkspaceSlugs = new SvelteSet<string>();

      for (const workspace of backendWorkspaces) {
        const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
        const workspaceId = sidebarWorkspace.workspaceDbId;
        if (!workspaceId) continue;
        validWorkspaceSlugs.add(sidebarWorkspace.id);

        const channels = await service.listChannels(workspaceId);
        for (const channel of channels as ChannelDto[]) {
          const actualId = channel.id || channel._id;
          if (!actualId) continue;

          if (channel.keyBootstrap) {
            await hydrateChannelBootstrap(actualId, channel.keyBootstrap).catch((error) => {
              ctx.log(
                `[CHANNEL-KEY] Echec hydratation pour #${channel.name}: ${error instanceof Error ? error.message : String(error)}`
              );
            });
          }

          const channelConversationId = `channel_${actualId}`;
          if (!validChannelConversationIds.includes(channelConversationId)) {
            validChannelConversationIds.push(channelConversationId);
          }
          addChannelToWorkspace(sidebarWorkspace.id, {
            id: channelConversationId,
            name: channel.name,
            isPrivate: channel.visibility === 'private',
          });

          const existing = ctx.conversations.get(channelConversationId);
          ctx.conversations.set(channelConversationId, {
            contactName: channelConversationId,
            name: channel.name,
            id: channelConversationId,
            messages: existing?.messages ?? [],
            lifecycle: 'active',
            mlsStateHex: null,
            ...(existing?.unreadCount !== undefined ? { unreadCount: existing.unreadCount } : {}),
          });
        }
      }

      const selectedChannel = ctx.getSelectedConversationId?.();
      if (selectedChannel && isChannelConversationId(selectedChannel) && ctx.reloadChannelHistory) {
        await ctx.reloadChannelHistory(selectedChannel);
      }

      const staleLocalChannelIds = Array.from(ctx.conversations.keys()).filter(
        (id) => isChannelConversationId(id) && !validChannelConversationIds.includes(id)
      );
      for (const staleId of staleLocalChannelIds) {
        ctx.invalidateChannelHistoryCache?.(staleId);
        ctx.conversations.delete(staleId);
        removeChannelFromWorkspaces(staleId);
        if (selectedChannelConversationId === staleId) {
          selectedChannelConversationId = '';
        }
        await ctx.deleteConversation?.(staleId).catch(() => {});
      }

      // Prune workspaces that no longer exist on the server.
      channelWorkspaces = channelWorkspaces.filter((ws) => validWorkspaceSlugs.has(ws.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`Failed to load communities/channels: ${message}`);
    } finally {
      isLoadingWorkspaces = false;
    }
    // A refresh ran (a failed one still consumed its attempt); only the busy guard above reports
    // false, so a caller retries exactly when its request was never served.
    return true;
  }

  /** Creates a new workspace with the given name, loads its default channels, then auto-selects the first channel. */
  async function ensureWorkspaceByName(
    nameRaw: string,
    ctx: ChannelWorkspaceContext
  ): Promise<ChannelSidebarWorkspace> {
    const slug = slugifyWorkspace(nameRaw.trim());
    if (!slug) throw new Error('Invalid community name.');

    const workspace = await service.createWorkspace({ slug, name: nameRaw.trim() });
    const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
    const workspaceId = sidebarWorkspace.workspaceDbId;

    // Immediately load the channels the backend created (e.g. the default "general" channel)
    // so the sidebar populates without requiring a page reload.
    if (workspaceId) {
      try {
        const channels = await service.listChannels(workspaceId);
        for (const channel of channels as ChannelDto[]) {
          const actualId = channel.id || channel._id;
          if (!actualId) continue;

          if (channel.keyBootstrap) {
            await hydrateChannelBootstrap(actualId, channel.keyBootstrap).catch(() => {});
          }

          const channelConversationId = `channel_${actualId}`;
          addChannelToWorkspace(sidebarWorkspace.id, {
            id: channelConversationId,
            name: channel.name,
            isPrivate: channel.visibility === 'private',
          });
          const existingEws = ctx.conversations.get(channelConversationId);
          ctx.conversations.set(channelConversationId, {
            contactName: channelConversationId,
            name: channel.name,
            id: channelConversationId,
            messages: [],
            lifecycle: 'active',
            mlsStateHex: null,
            ...(existingEws?.unreadCount !== undefined
              ? { unreadCount: existingEws.unreadCount }
              : {}),
          });
        }
      } catch {
        // Non-fatal: channels will load on next full refresh
      }
    }

    // Auto-select the first channel (usually "general")
    const freshWorkspace = channelWorkspaces.find((w) => w.id === sidebarWorkspace.id);
    if (freshWorkspace && freshWorkspace.channels.length > 0) {
      selectedChannelConversationId = freshWorkspace.channels[0].id;
      ctx.selectConversation(freshWorkspace.channels[0].id);
    }
    return freshWorkspace ?? sidebarWorkspace;
  }

  /** Public action: creates a new community (workspace) and logs the outcome. Errors are caught and surfaced via ctx.log. */
  async function createNewCommunity(nameRaw: string, ctx: ChannelWorkspaceContext) {
    const normalized = nameRaw.trim();
    if (!normalized) return;
    try {
      await ensureWorkspaceByName(normalized, ctx);
      ctx.log(`Community created: ${normalized}`);
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_community_create(), error));
    }
  }

  /**
   * Creates a channel in the given workspace with the specified visibility,
   * hydrates its encryption key, adds it to the sidebar, and selects it.
   */
  async function createNewChannel(
    workspaceId: string,
    nameRaw: string,
    ctx: ChannelWorkspaceContext,
    visibility: 'public' | 'private' = 'public'
  ) {
    if (!workspaceId) {
      ctx.log('Cannot create channel: select a community first.');
      return;
    }
    const normalizedChannelName = nameRaw.trim().toLowerCase();
    if (!normalizedChannelName) return;

    try {
      const createdChannel = await service.createChannel({
        workspaceId,
        name: normalizedChannelName,
        visibility,
      });

      const actualId =
        createdChannel?.id || createdChannel?._id || `${workspaceId}_${normalizedChannelName}`;
      const channelId = `channel_${actualId}`;

      const bootstrap = createdChannel?.keyBootstrap;
      if (bootstrap) {
        try {
          const hydrated = await hydrateChannelBootstrap(actualId, bootstrap);
          ctx.log(
            `[CHANNEL-KEY] Initial key loaded for #${normalizedChannelName} (v${hydrated.keyVersion}).`
          );
        } catch (e) {
          ctx.log(
            `[CHANNEL-KEY] Echec chargement cle initiale pour #${normalizedChannelName}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      const isPrivate = visibility === 'private';
      const sidebarWorkspace = channelWorkspaces.find((w) => w.workspaceDbId === workspaceId);
      if (sidebarWorkspace) {
        addChannelToWorkspace(sidebarWorkspace.id, {
          id: channelId,
          name: normalizedChannelName,
          isPrivate,
        });
      }

      selectedChannelConversationId = channelId;

      ctx.conversations.set(channelId, {
        contactName: channelId,
        name: normalizedChannelName,
        id: channelId,
        messages: [],
        lifecycle: 'active',
        mlsStateHex: null,
      });
      await ctx.saveConversation(channelId);
      ctx.selectConversation(channelId);
      ctx.log(`Channel created: #${normalizedChannelName} (${visibility})`);
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_channel_create(), error));
    }
  }

  /** Invites a user to a channel with the given role, then delivers the HKDF key distribution payload via an MLS direct message so the invitee can decrypt future channel messages. */
  async function inviteMemberToChannel(
    channelConversationId: string,
    memberIdRaw: string,
    roleName: 'member' | 'moderator' | 'admin',
    ctx: ChannelWorkspaceContext
  ) {
    const memberId = memberIdRaw.trim().toLowerCase();
    const channelId = channelConversationId.replace(/^channel_/, '');
    if (!memberId || !channelId) return;

    const currentWorkspace = channelWorkspaces.find((workspace) =>
      workspace.channels.some((channel) => channel.id === channelConversationId)
    );
    const currentChannel = currentWorkspace?.channels.find(
      (channel) => channel.id === channelConversationId
    );
    const channelDisplayName = currentChannel?.name || channelId;
    // Left undefined rather than defaulted to a literal: every consumer already falls back to the
    // channel name, and a hardcoded default would ship an untranslated string into the invite card.
    const workspaceDisplayName = currentWorkspace?.name || undefined;
    // Travels with the invitation so both cards show the community's real logo; absent means the
    // card falls back to the community initials, which is also what an old envelope renders.
    const workspaceImageMediaId = currentWorkspace?.imageMediaId || undefined;

    try {
      // Map frontend role names to backend role names (capitalized)
      const backendRoleName =
        roleName === 'admin'
          ? 'Administrateur'
          : roleName === 'moderator'
            ? 'Modérateur'
            : 'Membre';
      const inviteResult = await service.inviteToChannel(channelId, {
        targetUserId: memberId,
        roleName: backendRoleName,
      });

      if (inviteResult.keyDistribution && ctx.ensureMls && ctx.startDirectConversation) {
        const previousSelection = ctx.getSelectedConversationId?.() ?? null;
        try {
          await ctx.startDirectConversation(memberId, { silent: true });
          const directConvo = Array.from(ctx.conversations.entries()).find(([, convo]) => {
            if ((convo.conversationType ?? 'group') !== 'direct') return false;
            return (convo.directPeerId ?? convo.contactName).toLowerCase() === memberId;
          });

          if (directConvo) {
            const mlsService = await ctx.ensureMls();
            const controlMsg = encodeAppMessage(
              mkSystem(
                'channel_key_distribution',
                JSON.stringify({
                  ...inviteResult.keyDistribution,
                  channelName: channelDisplayName,
                  workspaceName: workspaceDisplayName,
                })
              )
            );
            await mlsService.sendMessage(directConvo[1].id, controlMsg);

            // Send a channel_invitation message, visible in the DM conversation
            const inviterId = currentUserId();
            if (inviterId) {
              const getName = await resolveDisplayNames([memberId, inviterId]);
              const invitationMsg = encodeAppMessage(
                mkSystem(
                  'channel_invitation',
                  JSON.stringify({
                    channelId,
                    channelName: channelDisplayName,
                    workspaceName: workspaceDisplayName,
                    workspaceImageMediaId,
                    inviterId,
                    inviterName: getName(inviterId),
                    inviteeId: memberId,
                    inviteeName: getName(memberId),
                  })
                )
              );
              try {
                await mlsService.sendMessage(directConvo[1].id, invitationMsg);
                // MLS never hands a device back its own application message, so the inviter's
                // copy of the card would never appear on THIS device. Insert it locally; their
                // other devices build the same envelope from the incoming event.
                await ctx.addMessageToChat?.(
                  'system',
                  serializeEnvelope(
                    mkChannelInviteSentEnvelope(
                      channelId,
                      workspaceDisplayName || channelDisplayName,
                      workspaceDisplayName,
                      getName(memberId),
                      workspaceImageMediaId
                    )
                  ),
                  directConvo[0],
                  { isSystem: true }
                );
              } catch (err) {
                console.warn('[Channel Invite] Failed to send invitation message:', err);
              }
            }

            await service.markKeyDistributionSent(
              channelId,
              inviteResult.keyDistribution.distributionId
            );
          } else {
            throw new Error('Private MLS conversation not found after creation');
          }
        } finally {
          if (previousSelection) ctx.selectConversation(previousSelection);
        }
      }

      // Send an encrypted system message into the channel to notify its members
      const inviterId = currentUserId();
      const getName = await resolveDisplayNames(inviterId ? [memberId, inviterId] : [memberId]);
      const displayName = getName(memberId);

      if (inviterId) {
        try {
          const inviterName = getName(inviterId);
          const systemText = m.chat_system_member_added({
            sender: inviterName,
            members: displayName,
          });
          const systemBytes = encodeAppMessage(mkSystem('memberAdded', systemText as string));
          await sendEncryptedChannelMessage(channelConversationId, systemBytes);
        } catch (err) {
          console.warn('[Channel Invite] Failed to send system message to channel:', err);
          // Do not block the invitation if the system message fails
        }
      }

      ctx.log(`Member invited to channel (${roleName}): ${displayName}`);
    } catch (error) {
      // Suppress the toast: the invite modal re-surfaces this error inline via inviteStatus.
      const msg = toUiActionError(m.channel_action_channel_invite(), error, false);
      ctx.log(msg);
      throw error;
    }
  }

  /** Updates the role of an existing channel member (member / moderator / admin). */
  async function updateChannelMemberRole(
    channelConversationId: string,
    memberIdRaw: string,
    roleName: 'member' | 'moderator' | 'admin',
    ctx: ChannelWorkspaceContext
  ) {
    const memberId = memberIdRaw.trim().toLowerCase();
    const channelId = channelConversationId.replace(/^channel_/, '');
    if (!memberId || !channelId) return;

    try {
      const backendRoleName =
        roleName === 'admin'
          ? 'Administrateur'
          : roleName === 'moderator'
            ? 'Modérateur'
            : 'Membre';
      await service.updateMemberRole(channelId, {
        targetUserId: memberId,
        roleName: backendRoleName,
      });
      ctx.log(`Role updated (${roleName}) for: ${memberId}`);
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_role_update(), error));
    }
  }

  /** Removes the current user from a channel, deletes the local conversation entry, and cleans up the sidebar. */
  async function leaveCurrentChannel(channelConversationId: string, ctx: ChannelWorkspaceContext) {
    if (!channelConversationId) return;
    try {
      await service.leaveChannel(channelConversationId);
      ctx.invalidateChannelHistoryCache?.(channelConversationId);
      ctx.conversations.delete(channelConversationId);
      await ctx.deleteConversation?.(channelConversationId).catch(() => {});
      removeChannelFromWorkspaces(channelConversationId);
      if (selectedChannelConversationId === channelConversationId) {
        selectedChannelConversationId = '';
      }
      ctx.log('You have left the channel.');
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_channel_leave(), error));
    }
  }

  /**
   * Drops a workspace from local state: its channels leave the conversations map and local
   * storage, the workspace leaves the sidebar, and the selection is cleared if it pointed
   * inside. Shared by the three ways a community can disappear - leaving it, deleting it, and
   * receiving the `workspace.deleted` broadcast for someone else's deletion.
   */
  async function purgeWorkspaceLocally(workspaceDbId: string, ctx: WorkspacePurgeContext) {
    const workspace = channelWorkspaces.find((ws) => ws.workspaceDbId === workspaceDbId);
    if (workspace) {
      for (const ch of workspace.channels) {
        ctx.invalidateChannelHistoryCache?.(ch.id);
        ctx.conversations.delete(ch.id);
        await ctx.deleteConversation?.(ch.id).catch(() => {});
      }
    }
    channelWorkspaces = channelWorkspaces.filter((ws) => ws.workspaceDbId !== workspaceDbId);
    const wsChannelIds = workspace?.channels.map((c) => c.id) ?? [];
    if (wsChannelIds.includes(selectedChannelConversationId)) {
      selectedChannelConversationId = '';
    }
  }

  /** Removes the current user from a workspace, purges all of its channels from conversations and the sidebar, then deselects if the active channel was in that workspace. */
  async function leaveCurrentWorkspace(workspaceDbId: string, ctx: ChannelWorkspaceContext) {
    if (!workspaceDbId) return;
    try {
      await service.leaveWorkspace(workspaceDbId);
      await purgeWorkspaceLocally(workspaceDbId, ctx);
      ctx.log('You have left the community.');
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_community_leave(), error));
    }
  }

  /**
   * Deletes a whole community (admin-only, server-enforced) and purges it locally. Other
   * members are cleaned up by the `workspace.deleted` broadcast, so nothing here fans out.
   */
  async function deleteCurrentWorkspace(workspaceDbId: string, ctx: ChannelWorkspaceContext) {
    if (!workspaceDbId) return;
    try {
      await service.deleteWorkspace(workspaceDbId);
      await purgeWorkspaceLocally(workspaceDbId, ctx);
      ctx.log('Community deleted.');
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_community_delete(), error));
    }
  }

  /**
   * Replaces a channel message with the local "deleted" tombstone, mirroring how a deleted DM
   * renders. The server row is already gone, so this is purely what the reader sees until the
   * next history reload drops it entirely.
   */
  function markChannelMessageDeleted(
    channelConversationId: string,
    messageId: string,
    ctx: WorkspacePurgeContext
  ) {
    const convo = ctx.conversations.get(channelConversationId);
    if (!convo) return;
    const idx = convo.messages.findIndex((msg) => msg.id === messageId);
    if (idx === -1) return;
    const messages = [...convo.messages];
    messages[idx] = {
      ...messages[idx],
      isDeleted: true,
      content: m.chat_system_message_deleted(),
    };
    ctx.conversations.set(channelConversationId, { ...convo, messages });
  }

  /**
   * Deletes a message from a community channel. The server allows the author unconditionally
   * and a `channel.moderate` holder for anyone else's, then broadcasts the removal - so other
   * members are handled by {@link handleChannelMessageDeleted}, not by this call.
   */
  async function deleteChannelMessage(
    channelConversationId: string,
    messageId: string,
    ctx: ChannelWorkspaceContext
  ) {
    if (!channelConversationId || !messageId) return;
    try {
      await service.deleteChannelMessage(channelConversationId, messageId);
      markChannelMessageDeleted(channelConversationId, messageId, ctx);
      ctx.invalidateChannelHistoryCache?.(channelConversationId);
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_message_delete(), error));
    }
  }

  /**
   * Toggles the caller's emoji reaction on a channel message. The pill flips immediately, then
   * the server's authoritative tally replaces it - and the same tally reaches everyone else as a
   * `channel.reaction` broadcast. On failure the optimistic toggle is rolled back by re-applying
   * it, since the toggle is its own inverse.
   */
  async function toggleChannelReaction(
    channelConversationId: string,
    messageId: string,
    emoji: string,
    ctx: ChannelWorkspaceContext
  ) {
    const userId = currentUserId();
    if (!channelConversationId || !messageId || !emoji || !userId) return;
    applyLocalChannelReaction(messageId, userId, emoji);
    try {
      const tally = await service.toggleReaction(channelConversationId, messageId, emoji);
      setChannelReactions(messageId, tally);
    } catch (error) {
      applyLocalChannelReaction(messageId, userId, emoji);
      ctx.log(toUiActionError(m.channel_action_message_react(), error));
    }
  }

  /** Applies a `channel.message.deleted` broadcast (the author or a moderator removed a message). */
  function handleChannelMessageDeleted(
    event: { channelId: string; messageId: string },
    ctx: WorkspacePurgeContext
  ) {
    if (!event.channelId || !event.messageId) return;
    const channelConversationId = `channel_${event.channelId}`;
    markChannelMessageDeleted(channelConversationId, event.messageId, ctx);
    ctx.invalidateChannelHistoryCache?.(channelConversationId);
  }

  /** Applies a `workspace.deleted` broadcast: an admin deleted a community this user belongs to. */
  async function handleWorkspaceDeleted(
    event: { workspaceId: string },
    ctx: WorkspacePurgeContext
  ) {
    if (!event.workspaceId) return;
    ctx.log(`[Channel Event] community ${event.workspaceId.slice(0, 8)} deleted by an admin`);
    await purgeWorkspaceLocally(event.workspaceId, ctx);
  }

  /** Renames a channel on the server and updates both the sidebar label and the conversation entry optimistically. */
  async function renameCurrentChannel(
    channelConversationId: string,
    newName: string,
    ctx: ChannelWorkspaceContext
  ) {
    const trimmed = newName.trim().toLowerCase();
    if (!channelConversationId || !trimmed) return;
    try {
      await service.renameChannel(channelConversationId, trimmed);
      // Update sidebar label
      channelWorkspaces = channelWorkspaces.map((ws) => ({
        ...ws,
        channels: ws.channels.map((ch) =>
          ch.id === channelConversationId ? { ...ch, name: trimmed } : ch
        ),
      }));
      // Update conversation name
      const convo = ctx.conversations.get(channelConversationId);
      if (convo) {
        ctx.conversations.set(channelConversationId, { ...convo, name: trimmed });
      }
      ctx.log(`Channel renamed: #${trimmed}`);
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_channel_rename(), error));
    }
  }

  /** Permanently deletes a channel and removes it from conversations, the DB, and the sidebar. */
  async function deleteCurrentChannel(channelConversationId: string, ctx: ChannelWorkspaceContext) {
    if (!channelConversationId) return;
    try {
      await service.deleteChannel(channelConversationId);
      ctx.invalidateChannelHistoryCache?.(channelConversationId);
      ctx.conversations.delete(channelConversationId);
      await ctx.deleteConversation?.(channelConversationId).catch(() => {});
      removeChannelFromWorkspaces(channelConversationId);
      if (selectedChannelConversationId === channelConversationId) {
        selectedChannelConversationId = '';
      }
      ctx.log('Channel deleted.');
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_channel_delete(), error));
    }
  }

  /** Saves a new cover image for a workspace and optimistically updates the local sidebar entry. */
  async function updateCurrentWorkspaceImage(
    workspaceDbId: string,
    mediaId: string,
    ctx: ChannelWorkspaceContext
  ) {
    if (!workspaceDbId || !mediaId) return;
    try {
      await service.updateWorkspaceImage(workspaceDbId, mediaId);
      // Optimistically update the local workspace entry
      channelWorkspaces = channelWorkspaces.map((ws) =>
        ws.workspaceDbId === workspaceDbId ? { ...ws, imageMediaId: mediaId } : ws
      );
      ctx.log('Community image updated.');
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_community_image(), error));
    }
  }

  /**
   * Applies a drag-and-drop reorder of the sidebar communities optimistically, then persists it
   * server-side. Rolls back to the previous order if the request fails.
   */
  async function reorderWorkspaces(
    newOrder: ChannelSidebarWorkspace[],
    ctx: ChannelWorkspaceContext
  ) {
    const previous = channelWorkspaces;
    channelWorkspaces = newOrder;
    try {
      const orderedIds = newOrder
        .map((ws) => ws.workspaceDbId)
        .filter((id): id is string => Boolean(id));
      await service.reorderWorkspaces(orderedIds);
    } catch (error) {
      channelWorkspaces = previous;
      ctx.log(toUiActionError(m.channel_action_community_reorder(), error));
    }
  }

  /** Applies an incoming real-time workspace-updated event (currently: cover image change). */
  function handleWorkspaceUpdated(event: { workspaceId: string; imageMediaId?: string }) {
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.workspaceDbId === event.workspaceId
        ? { ...ws, imageMediaId: event.imageMediaId ?? ws.imageMediaId }
        : ws
    );
  }

  return {
    /** Reactive array of workspace entries shown in the sidebar. */
    get channelWorkspaces() {
      return channelWorkspaces;
    },
    set channelWorkspaces(v) {
      channelWorkspaces = v;
    },
    /** Conversation ID of the channel currently highlighted in the sidebar. */
    get selectedChannelConversationId() {
      return selectedChannelConversationId;
    },
    set selectedChannelConversationId(v) {
      selectedChannelConversationId = v;
    },
    /** Inserts or updates a workspace sidebar entry from a backend DTO. */
    upsertWorkspaceFromDto,
    /** Appends a channel to the sidebar entry for the given workspace slug, ignoring duplicates. */
    addChannelToWorkspace,
    /** Removes the given channel conversation ID from every workspace in the sidebar. */
    removeChannelFromWorkspaces,
    /** Returns or creates a sidebar workspace entry for an incoming real-time channel event. */
    ensureWorkspaceForChannelEvent,
    /** Loads the encryption key for a channel the user was just added to in-session (no relaunch needed). */
    hydrateJoinedChannelKey,
    /** Fetches all workspaces and channels from the backend and prunes stale local entries. */
    loadChannelWorkspacesFromBackend,
    /** Creates a new community (workspace) and logs the outcome. */
    createNewCommunity,
    /** Creates a new public channel in the given workspace and selects it. */
    createNewChannel,
    /** Invites a user to a channel and delivers the HKDF key via an MLS direct message. */
    inviteMemberToChannel,
    /** Updates the role of an existing channel member. */
    updateChannelMemberRole,
    /** Removes the current user from a channel and cleans up local state. */
    leaveCurrentChannel,
    /** Removes the current user from a workspace and purges all its channels locally. */
    leaveCurrentWorkspace,
    /** Deletes an entire community for every member (admin-only) and purges it locally. */
    deleteCurrentWorkspace,
    /** Renames a channel on the server and updates the sidebar and conversation entry. */
    renameCurrentChannel,
    /** Permanently deletes a channel and removes it from conversations and the sidebar. */
    deleteCurrentChannel,
    /** Saves a new cover image for a workspace and updates the sidebar entry optimistically. */
    updateCurrentWorkspaceImage,
    /** Applies a drag-and-drop reorder of the sidebar communities and persists it server-side. */
    reorderWorkspaces,
    /** Applies an incoming real-time workspace-updated event (cover image change). */
    handleWorkspaceUpdated,
    /** Applies an incoming real-time workspace-deleted event (an admin deleted the community). */
    handleWorkspaceDeleted,
    /** Deletes a channel message (own message, or anyone's with `channel.moderate`). */
    deleteChannelMessage,
    /** Toggles the caller's emoji reaction on a channel message. */
    toggleChannelReaction,
    /** Applies an incoming real-time channel-message-deleted event. */
    handleChannelMessageDeleted,
  };
}
