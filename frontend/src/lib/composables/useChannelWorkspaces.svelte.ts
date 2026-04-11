import { SvelteMap } from 'svelte/reactivity';
import { ChannelService } from '$lib/services/ChannelService';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import type { IMlsService } from '$lib/mlsService';
import type { Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import { hydrateChannelBootstrap } from '$lib/utils/chat/channelCrypto';

export interface ChannelSidebarItem {
  id: string;
  name: string;
  unreadCount?: number;
  isPrivate?: boolean;
}

export interface ChannelSidebarWorkspace {
  id: string;
  name: string;
  workspaceDbId?: string;
  avatarUserId: string;
  imageMediaId?: string | null;
  channels: ChannelSidebarItem[];
}

export interface ChannelWorkspaceContext {
  conversations: SvelteMap<string, Conversation>;
  saveConversation: (id: string) => Promise<void>;
  deleteConversation?: (id: string) => Promise<void>;
  selectConversation: (id: string) => void;
  ensureMls?: () => IMlsService | Promise<IMlsService>;
  startDirectConversation?: (targetUserId: string) => Promise<void>;
  getSelectedConversationId?: () => string | null;
  log: (msg: string) => void;
}

export function useChannelWorkspaces() {
  let channelWorkspaces = $state<ChannelSidebarWorkspace[]>([]);
  let selectedChannelConversationId = $state('');

  const service = new ChannelService();

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

  function slugifyWorkspace(name: string): string {
    return name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
  }

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

  function removeChannelFromWorkspaces(channelConversationId: string) {
    channelWorkspaces = channelWorkspaces.map((workspace) => ({
      ...workspace,
      channels: workspace.channels.filter((channel) => channel.id !== channelConversationId),
    }));
  }

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

      const staleLocalChannelIds = Array.from(ctx.conversations.keys()).filter(
        (id) => id.startsWith('channel_') && !validChannelConversationIds.includes(id)
      );
      for (const staleId of staleLocalChannelIds) {
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
            messages: existingEws?.messages ?? [],
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

  async function inviteMemberToChannel(
    channelConversationId: string,
    memberIdRaw: string,
    roleName: 'member' | 'moderator' | 'admin',
    ctx: ChannelWorkspaceContext
  ) {
    const memberId = memberIdRaw.trim().toLowerCase();
    const channelId = channelConversationId.replace(/^channel_/, '');
    if (!memberId || !channelId) return;

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
              mkSystem('channel_key_distribution', JSON.stringify(inviteResult.keyDistribution))
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
      ctx.log(toUiActionError(`Invitation dans le canal (${roleName})`, error));
    }
  }

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
      await service.updateMemberRole(channelId, { targetUserId: memberId, roleName });
      ctx.log(`Rôle mis à jour (${roleName}) pour : ${memberId}`);
    } catch (error) {
      ctx.log(toUiActionError(`Mise à jour du rôle (${roleName})`, error));
    }
  }

  async function leaveCurrentChannel(channelConversationId: string, ctx: ChannelWorkspaceContext) {
    if (!channelConversationId) return;
    try {
      await service.leaveChannel(channelConversationId);
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

  async function deleteCurrentChannel(channelConversationId: string, ctx: ChannelWorkspaceContext) {
    if (!channelConversationId) return;
    try {
      await service.deleteChannel(channelConversationId);
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

  function handleWorkspaceUpdated(event: { workspaceId: string; imageMediaId?: string }) {
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.workspaceDbId === event.workspaceId
        ? { ...ws, imageMediaId: event.imageMediaId ?? ws.imageMediaId }
        : ws
    );
  }

  return {
    get channelWorkspaces() {
      return channelWorkspaces;
    },
    set channelWorkspaces(v) {
      channelWorkspaces = v;
    },
    get selectedChannelConversationId() {
      return selectedChannelConversationId;
    },
    set selectedChannelConversationId(v) {
      selectedChannelConversationId = v;
    },
    upsertWorkspaceFromDto,
    addChannelToWorkspace,
    removeChannelFromWorkspaces,
    ensureWorkspaceForChannelEvent,
    loadChannelWorkspacesFromBackend,
    createNewCommunity,
    createNewChannel,
    inviteMemberToChannel,
    updateChannelMemberRole,
    leaveCurrentChannel,
    renameCurrentChannel,
    deleteCurrentChannel,
    updateCurrentChannelImage,
    updateCurrentWorkspaceImage,
    handleWorkspaceUpdated,
  };
}
