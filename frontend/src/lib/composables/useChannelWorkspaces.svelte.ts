import { SvelteMap } from 'svelte/reactivity';
import { ChannelService } from '$lib/services/ChannelService';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import type { Conversation } from '$lib/types';
import { channelKeyManager } from '$lib/crypto/ChannelKeyVault';

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
  channels: ChannelSidebarItem[];
}

export interface ChannelWorkspaceContext {
  conversations: SvelteMap<string, Conversation>;
  saveConversation: (id: string) => Promise<void>;
  selectConversation: (id: string) => void;
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

  // ---------- Key bootstrapping ----------

  async function bootstrapChannelKey(rawChannelId: string) {
    const vault = channelKeyManager.getVault(rawChannelId);
    try {
      vault.getCurrentKey();
      // Key already exists – nothing to do
      return;
    } catch {
      // No key yet – fetch from backend
    }
    try {
      const { epochKey, keyVersion } = await service.getChannelKey(rawChannelId);
      const rawKeyMat = Uint8Array.from(atob(epochKey), (c) => c.charCodeAt(0));
      await vault.rotateKey(keyVersion, rawKeyMat);
    } catch {
      // Fallback: derive deterministically (legacy/offline mode)
      const encoded = new TextEncoder().encode(`canari-channel-key:${rawChannelId}`);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
      await vault.rotateKey(0, hash);
    }
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
      channelWorkspaces = [...channelWorkspaces];
      return existing;
    }

    const created: ChannelSidebarWorkspace = {
      id: workspaceSlug,
      name: workspace.name,
      workspaceDbId: workspaceId,
      avatarUserId: workspace.name || workspaceSlug,
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
      channelWorkspaces = [...channelWorkspaces];
      return existing;
    }

    const created: ChannelSidebarWorkspace = {
      id: slugFromEvent || `workspace-${workspaceId || crypto.randomUUID().slice(0, 8)}`,
      name: workspaceName,
      workspaceDbId: workspaceId,
      avatarUserId: workspaceName || slugFromEvent || 'workspace',
      channels: [],
    };
    channelWorkspaces = [...channelWorkspaces, created];
    return created;
  }

  // ---------- API operations ----------

  async function loadChannelWorkspacesFromBackend(ctx: ChannelWorkspaceContext) {
    try {
      const backendWorkspaces = await service.listUserWorkspaces();

      for (const workspace of backendWorkspaces) {
        const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
        const workspaceId = sidebarWorkspace.workspaceDbId;
        if (!workspaceId) continue;

        const channels = await service.listChannels(workspaceId);
        for (const channel of channels as ChannelDto[]) {
          const actualId = channel.id || channel._id;
          if (!actualId) continue;

          const channelConversationId = `channel_${actualId}`;
          addChannelToWorkspace(sidebarWorkspace.id, {
            id: channelConversationId,
            name: channel.name,
            isPrivate: channel.visibility === 'private',
          });

          await bootstrapChannelKey(actualId);

          if (!ctx.conversations.has(channelConversationId)) {
            ctx.conversations.set(channelConversationId, {
              contactName: channelConversationId,
              name: channel.name,
              id: channelConversationId,
              messages: [],
              isReady: true,
              mlsStateHex: null,
            });
          }
        }
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
          const channelConversationId = `channel_${actualId}`;
          addChannelToWorkspace(sidebarWorkspace.id, {
            id: channelConversationId,
            name: channel.name,
            isPrivate: channel.visibility === 'private',
          });
          await bootstrapChannelKey(actualId);
          if (!ctx.conversations.has(channelConversationId)) {
            ctx.conversations.set(channelConversationId, {
              contactName: channelConversationId,
              name: channel.name,
              id: channelConversationId,
              messages: [],
              isReady: true,
              mlsStateHex: null,
            });
          }
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

      await bootstrapChannelKey(actualId);

      const sidebarWorkspace = channelWorkspaces.find((w) => w.workspaceDbId === workspaceId);
      if (sidebarWorkspace) {
        addChannelToWorkspace(sidebarWorkspace.id, {
          id: channelId,
          name: normalizedChannelName,
          isPrivate: false,
        });
      }

      selectedChannelConversationId = channelId;

      if (!ctx.conversations.has(channelId)) {
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
      }
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
        roleName === 'admin' ? 'Admin' : roleName === 'moderator' ? 'Moderator' : 'Member';
      await service.inviteToChannel(channelId, {
        targetUserId: memberId,
        roleName: backendRoleName,
      });
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
      removeChannelFromWorkspaces(channelConversationId);
      if (selectedChannelConversationId === channelConversationId) {
        selectedChannelConversationId = '';
      }
      ctx.log('Canal supprimé.');
    } catch (error) {
      ctx.log(toUiActionError('Suppression du canal', error));
    }
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
  };
}
