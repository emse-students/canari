import { SvelteMap } from 'svelte/reactivity';
import { ChannelService } from '$lib/services/ChannelService';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { hydrateChannelBootstrap, isChannelConversationId } from '$lib/utils/chat/channelCrypto';

/** One channel entry shown in the sidebar under its workspace. */
export interface ChannelSidebarItem {
  /** Conversation ID, prefixed with "channel_". */
  id: string;
  /** Display name of the channel (e.g. "général"). */
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
  /** Opens (or creates) a direct MLS conversation with the given user. */
  startDirectConversation?: (targetUserId: string) => Promise<void>;
  /** Returns the conversation ID currently visible in the chat panel. */
  getSelectedConversationId?: () => string | null;
  /** Refetch channel messages from the server (in-memory only). */
  reloadChannelHistory?: (channelConversationId: string) => Promise<void>;
  /** Drops cached channel history so the next open refetches from the API. */
  invalidateChannelHistoryCache?: (channelConversationId: string) => void;
  /** Appends a message to the debug log panel. */
  log: (msg: string) => void;
}

/** Creates and returns the reactive channel/workspace store: sidebar state, API operations (create, rename, delete, invite, leave, image update), and real-time event handlers. */
export function useChannelWorkspaces() {
  let channelWorkspaces = $state<ChannelSidebarWorkspace[]>([]);
  let selectedChannelConversationId = $state('');

  const service = new ChannelService();

  /** Maps a raw API error to a user-friendly French error message for the given action label. */
  function toUiActionError(action: string, error: unknown): string {
    const raw = error instanceof Error ? error.message : String(error);
    const lower = raw.toLowerCase();

    if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized')) {
      return `${action} impossible: session expirée ou droits insuffisants. Reconnectez-vous.`;
    }
    if (lower.includes('409') || lower.includes('already')) {
      return `${action} impossible: élément déjà existant.`;
    }
    if (lower.includes('network') || lower.includes('fetch') || lower.includes('failed to fetch')) {
      return `${action} impossible: service indisponible. Vérifiez la connexion réseau.`;
    }

    return `${action} impossible: ${raw}`;
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
      channelWorkspaces = [...channelWorkspaces];
      return existing;
    }

    const created: ChannelSidebarWorkspace = {
      id: workspaceSlug,
      name: workspace.name,
      workspaceDbId: workspaceId,
      avatarUserId: workspace.name || workspaceSlug,
      imageMediaId: workspace.imageMediaId ?? null,
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
    const workspaceName = event.workspaceName?.trim() || 'Communauté';

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

  // ---------- API operations ----------

  /** Fetches all workspaces and their channels from the backend, hydrates channel encryption keys, and prunes stale local channel entries. */
  async function loadChannelWorkspacesFromBackend(ctx: ChannelWorkspaceContext) {
    try {
      const backendWorkspaces = await service.listUserWorkspaces();
      const validChannelConversationIds: string[] = [];

      for (const workspace of backendWorkspaces) {
        const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
        const workspaceId = sidebarWorkspace.workspaceDbId;
        if (!workspaceId) continue;

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
            isReady: true,
            mlsStateHex: null,
            imageMediaId: channel.imageMediaId ?? null,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log(`Chargement des communautés/canaux impossible: ${message}`);
    }
  }

  /** Creates a new workspace with the given name, loads its default channels, then auto-selects the first channel. */
  async function ensureWorkspaceByName(
    nameRaw: string,
    ctx: ChannelWorkspaceContext
  ): Promise<ChannelSidebarWorkspace> {
    const slug = slugifyWorkspace(nameRaw.trim());
    if (!slug) throw new Error('Nom de communauté invalide.');

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
            isReady: true,
            mlsStateHex: null,
            imageMediaId: channel.imageMediaId ?? null,
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
      ctx.log(`Communauté créée : ${normalized}`);
    } catch (error) {
      ctx.log(toUiActionError('Création de communauté', error));
    }
  }

  /** Creates a public channel in the given workspace, hydrates its encryption key, adds it to the sidebar, and selects it. */
  async function createNewChannel(
    workspaceId: string,
    nameRaw: string,
    ctx: ChannelWorkspaceContext
  ) {
    if (!workspaceId) {
      ctx.log("Création de canal impossible: sélectionnez d'abord une communauté.");
      return;
    }
    const normalizedChannelName = nameRaw.trim().toLowerCase();
    if (!normalizedChannelName) return;

    try {
      const createdChannel = await service.createChannel({
        workspaceId,
        name: normalizedChannelName,
        visibility: 'public',
      });

      const actualId =
        createdChannel?.id || createdChannel?._id || `${workspaceId}_${normalizedChannelName}`;
      const channelId = `channel_${actualId}`;

      const bootstrap = createdChannel?.keyBootstrap;
      if (bootstrap) {
        try {
          const hydrated = await hydrateChannelBootstrap(actualId, bootstrap);
          ctx.log(
            `[CHANNEL-KEY] Cle initiale chargee pour #${normalizedChannelName} (v${hydrated.keyVersion}).`
          );
        } catch (e) {
          ctx.log(
            `[CHANNEL-KEY] Echec chargement cle initiale pour #${normalizedChannelName}: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      const sidebarWorkspace = channelWorkspaces.find((w) => w.workspaceDbId === workspaceId);
      if (sidebarWorkspace) {
        addChannelToWorkspace(sidebarWorkspace.id, {
          id: channelId,
          name: normalizedChannelName,
          isPrivate: false,
        });
      }

      selectedChannelConversationId = channelId;

      ctx.conversations.set(channelId, {
        contactName: channelId,
        name: normalizedChannelName,
        id: channelId,
        messages: [],
        isReady: true,
        mlsStateHex: null,
      });
      await ctx.saveConversation(channelId);
      ctx.selectConversation(channelId);
      ctx.log(`Canal créé : #${normalizedChannelName}`);
    } catch (error) {
      ctx.log(toUiActionError('Création de canal', error));
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
    const workspaceDisplayName = currentWorkspace?.name || 'la communauté';

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
          await ctx.startDirectConversation(memberId);
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

            await service.markKeyDistributionSent(
              channelId,
              inviteResult.keyDistribution.distributionId
            );
          } else {
            throw new Error('Discussion privée MLS introuvable après création');
          }
        } finally {
          if (previousSelection) ctx.selectConversation(previousSelection);
        }
      }

      ctx.log(`Membre invité dans le canal (${roleName}) : ${memberId}`);
    } catch (error) {
      const msg = toUiActionError(`Invitation dans le canal (${roleName})`, error);
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
      ctx.log(`Rôle mis à jour (${roleName}) pour : ${memberId}`);
    } catch (error) {
      ctx.log(toUiActionError(`Mise à jour du rôle (${roleName})`, error));
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
      ctx.log('Vous avez quitté le canal.');
    } catch (error) {
      ctx.log(toUiActionError('Départ du canal', error));
    }
  }

  /** Removes the current user from a workspace, purges all of its channels from conversations and the sidebar, then deselects if the active channel was in that workspace. */
  async function leaveCurrentWorkspace(workspaceDbId: string, ctx: ChannelWorkspaceContext) {
    if (!workspaceDbId) return;
    try {
      await service.leaveWorkspace(workspaceDbId);
      // Remove all channels of the workspace from conversations map
      const workspace = channelWorkspaces.find((ws) => ws.workspaceDbId === workspaceDbId);
      if (workspace) {
        for (const ch of workspace.channels) {
          ctx.invalidateChannelHistoryCache?.(ch.id);
          ctx.conversations.delete(ch.id);
          await ctx.deleteConversation?.(ch.id).catch(() => {});
        }
      }
      // Remove workspace from sidebar
      channelWorkspaces = channelWorkspaces.filter((ws) => ws.workspaceDbId !== workspaceDbId);
      // Deselect if current channel was in this workspace
      const wsChannelIds = workspace?.channels.map((c) => c.id) ?? [];
      if (wsChannelIds.includes(selectedChannelConversationId)) {
        selectedChannelConversationId = '';
      }
      ctx.log('Vous avez quitté la communauté.');
    } catch (error) {
      ctx.log(toUiActionError('Départ de la communauté', error));
    }
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
      ctx.log(`Canal renommé : #${trimmed}`);
    } catch (error) {
      ctx.log(toUiActionError('Renommage du canal', error));
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
      ctx.log('Canal supprimé.');
    } catch (error) {
      ctx.log(toUiActionError('Suppression du canal', error));
    }
  }

  /** Saves a new cover image for a channel (by media-service ID) and optimistically updates the conversation entry. */
  async function updateCurrentChannelImage(
    channelConversationId: string,
    mediaId: string,
    ctx: ChannelWorkspaceContext
  ) {
    const channelId = channelConversationId.replace(/^channel_/, '');
    if (!channelId || !mediaId) return;
    try {
      await service.updateChannelImage(channelId, mediaId);
      // Optimistically update the conversation
      const convo = ctx.conversations.get(channelConversationId);
      if (convo) {
        ctx.conversations.set(channelConversationId, { ...convo, imageMediaId: mediaId });
      }
      ctx.log('Image du canal mise à jour.');
    } catch (error) {
      ctx.log(toUiActionError('Mise à jour image canal', error));
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
      ctx.log('Image de la communauté mise à jour.');
    } catch (error) {
      ctx.log(toUiActionError('Mise à jour image communauté', error));
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
    /** Renames a channel on the server and updates the sidebar and conversation entry. */
    renameCurrentChannel,
    /** Permanently deletes a channel and removes it from conversations and the sidebar. */
    deleteCurrentChannel,
    /** Saves a new cover image for a channel and updates the conversation optimistically. */
    updateCurrentChannelImage,
    /** Saves a new cover image for a workspace and updates the sidebar entry optimistically. */
    updateCurrentWorkspaceImage,
    /** Applies an incoming real-time workspace-updated event (cover image change). */
    handleWorkspaceUpdated,
  };
}
