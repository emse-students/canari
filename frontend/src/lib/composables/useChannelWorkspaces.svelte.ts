import { SvelteMap } from 'svelte/reactivity';
import { ChannelService } from '$lib/services/ChannelService';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import type { Conversation } from '$lib/types';

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

          if (!ctx.conversations.has(channelConversationId)) {
            ctx.conversations.set(channelConversationId, {
              contactName: channelConversationId,
              name: channel.name,
              groupId: channelConversationId,
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
    _ctx: ChannelWorkspaceContext
  ): Promise<ChannelSidebarWorkspace> {
    const slug = slugifyWorkspace(nameRaw.trim());
    if (!slug) throw new Error('Nom de communauté invalide.');

    const workspace = await service.createWorkspace({ slug, name: nameRaw.trim() });
    const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
    if (sidebarWorkspace.channels.length > 0) {
      selectedChannelConversationId = sidebarWorkspace.channels[0].id;
    }
    return sidebarWorkspace;
  }

  async function createNewCommunity(nameRaw: string, ctx: ChannelWorkspaceContext) {
    const normalized = nameRaw.trim();
    if (!normalized) return;
    await ensureWorkspaceByName(normalized, ctx);
    ctx.log(`Communauté créée : ${normalized}`);
  }

  async function createNewChannel(
    workspaceId: string,
    nameRaw: string,
    ctx: ChannelWorkspaceContext
  ) {
    if (!workspaceId) throw new Error("Vous devez d'abord sélectionner une communauté.");
    const normalizedChannelName = nameRaw.trim().toLowerCase();
    if (!normalizedChannelName) return;

    const createdChannel = await service.createChannel({
      workspaceId,
      name: normalizedChannelName,
      visibility: 'public',
    });

    const actualId =
      createdChannel?.id || createdChannel?._id || `${workspaceId}_${normalizedChannelName}`;
    const channelId = `channel_${actualId}`;

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
        groupId: channelId,
        messages: [],
        isReady: true,
        mlsStateHex: null,
      });
      await ctx.saveConversation(channelId);
      ctx.selectConversation(channelId);
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

    await service.joinChannel(channelId, { roleName });
    ctx.log(`Membre invité dans le canal (${roleName}) : ${memberId}`);
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

    await service.updateMemberRole(channelId, { targetUserId: memberId, roleName });
    ctx.log(`Rôle mis à jour (${roleName}) pour : ${memberId}`);
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
  };
}
