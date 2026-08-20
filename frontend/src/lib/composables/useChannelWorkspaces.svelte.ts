import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { ChannelService } from '$lib/services/ChannelService';
import type { WorkspaceDto, ChannelDto } from '$lib/services/ChannelService';
import type { IMlsService } from '$lib/mlsService';
import type { AddMessageToChatOptions, Conversation } from '$lib/types';
import { encodeAppMessage, mkSystem } from '$lib/proto/codec';
import {
  mkChannelInviteSentEnvelope,
  serializeEnvelope,
  channelInviteMessageId,
} from '$lib/envelope';
import {
  isChannelConversationId,
  sendChannelReaction,
  sendEncryptedChannelMessage,
} from '$lib/utils/chat/channelCrypto';
import {
  narrowHistoryVisibility,
  registerChannelWorkspace,
  registerCommunityHistoryVisibility,
} from '$lib/utils/graine/runtime';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import { channelScope } from '$lib/mls-client/distributionScope';
import { currentUserId } from '$lib/stores/userState.svelte';
import { applyChannelReactionFrame, getChannelReactions } from '$lib/stores/reactionStore.svelte';
import {
  activeReactions,
  canAddDistinctReactionEmoji,
  MAX_DISTINCT_MESSAGE_REACTIONS,
} from '$lib/utils/chat/messageReactions';
import { showToast } from '$lib/stores/toast.svelte';
import { m } from '$lib/paraglide/messages';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { notifyReaction } from '$lib/utils/chat/reactionNotify';
import { describeCommunityRefusal } from '$lib/utils/chat/communityErrors';
import {
  ensureCommunityDistributionGroup,
  ensureDistributionGroupFor,
} from '$lib/utils/graine/distributionGroup';
import { forgetCommunityGraine } from '$lib/utils/graine/forget';

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
  /**
   * Whether the viewer may READ this channel, as opposed to merely knowing it exists.
   *
   * False only on a private salon an administrator has not joined - the row that makes the join
   * reachable. Absent means yes: every other row in this list is one the viewer can open, and a
   * tri-state would make every consumer handle a case that cannot happen.
   */
  hasAccess?: boolean;
  /**
   * Whether the viewer may POST here - the salon's `writePolicy` applied to their own roles, decided
   * by the server (`viewerCanWrite`).
   *
   * Absent means yes, which is both the server's default policy and the only safe reading of a row
   * that has not been refreshed: a composer withheld on missing data would lock every salon whose
   * listing has not answered yet, and the server refuses a forbidden post regardless. This decides
   * whether the product OFFERS the control, never whether the message is accepted.
   */
  canWrite?: boolean;
}

/** One workspace (community) shown in the sidebar, containing its channels. */
export interface ChannelSidebarWorkspace {
  /** URL slug used as the local identifier (e.g. "emse-mine"). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** Server-side primary key of the workspace - may be absent until the first API sync. */
  workspaceDbId?: string;
  /** Seed for the avatar image fallback (usually the workspace name). */
  avatarUserId: string;
  /** media-service ID of the workspace cover image, if set. */
  imageMediaId?: string | null;
  /** Server-authoritative: true when the current user may manage this workspace (MANAGE_WORKSPACE). Gates admin controls. Defaults to false until the backend listing confirms it. */
  viewerCanManage?: boolean;
  /** Server-authoritative: true when the current user holds `channel.moderate` (or a permission that subsumes it) here, letting them delete other members' channel messages. */
  viewerCanModerate?: boolean;
  /** What this community lets a newcomer read. Absent until the backend listing says. */
  historyVisibility?: GraineHistoryVisibility;
  /** Ordered list of channels belonging to this workspace. */
  channels: ChannelSidebarItem[];
  /**
   * The creation tick at which THIS DEVICE made the community, or absent when the server named
   * it first. Compared against the tick a workspace listing was requested at, so a listing can
   * never delete a community that did not exist when it was asked for.
   */
  createdEpoch?: number;
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

/** Back-off delays in ms for workspace list retries after transient failures. */
const WORKSPACE_LOAD_RETRY_DELAYS = [1_000, 3_000, 7_000];

/** Creates and returns the reactive channel/workspace store: sidebar state, API operations (create, rename, delete, invite, leave, image update), and real-time event handlers. */
export function useChannelWorkspaces() {
  let channelWorkspaces = $state<ChannelSidebarWorkspace[]>([]);

  /**
   * How many communities and salons this device has created, ever - a tick, not a clock.
   *
   * IT EXISTS TO DATE A SERVER LISTING AGAINST A LOCAL FACT. `executeWorkspaceLoadAttempt` ends
   * by deleting everything the listing did not mention, and between the request going out and
   * that prune it awaits an MLS group join and a channel listing PER COMMUNITY - seconds, on a
   * real account. Anything created in that window is absent from an answer that was already on
   * its way, and was deleted for it: measured 2026-08-20, a community vanished from the sidebar
   * 1.5 s after it was created and the app dropped the user into an unrelated one.
   *
   * A COUNTER RATHER THAN A TIMESTAMP, deliberately. The question is not "how old is this" but
   * "did this exist when I asked", and a monotonic tick answers it exactly, with no clock to be
   * wrong about and nothing to tune.
   */
  let creationEpoch = 0;

  /**
   * Conversation id of every salon this device created, and the tick it created it at.
   *
   * The same protection as `createdEpoch`, for the half of the reconciliation that prunes
   * CHANNELS. A salon created during the window was dropped from the sidebar and its
   * conversation deleted, which is how COMM-12 came to log "Channel created" for a salon that
   * was not there a second later.
   */
  const locallyCreatedChannels = new SvelteMap<string, number>();
  let selectedChannelConversationId = $state('');
  let isLoadingWorkspaces = false;
  let workspacesLoadError = $state<string | null>(null);

  const service = new ChannelService();

  /**
   * Decides whether a workspace-load failure is worth retrying.
   *
   * Retryable: low-level network errors (a failed `fetch` throws a TypeError with no status at
   * all) and HTTP 5xx - which also covers the Bad Gateway body ChannelService turns into a
   * message, since `parseApiError` still reads the 502 out of it. Anything else, including a
   * malformed payload, is a client-side fact that a second identical request cannot change.
   */
  function isRetryableLoadError(error: unknown): boolean {
    const raw = error instanceof Error ? error.message : String(error);
    const hay = raw.toLowerCase();

    if (error instanceof TypeError) return true;
    if (
      hay.includes('fetch') ||
      hay.includes('network') ||
      hay.includes('timeout') ||
      hay.includes('abort') ||
      hay.includes('err_internet_disconnected')
    ) {
      return true;
    }

    const status = parseApiError(raw).status;
    return status !== undefined && status >= 500;
  }

  /**
   * Performs a single attempt to fetch and merge the workspace/channel list.
   * Mutates `channelWorkspaces` on success; on failure the existing list is left untouched.
   */
  async function executeWorkspaceLoadAttempt(ctx: ChannelWorkspaceContext): Promise<void> {
    // READ BEFORE THE REQUEST GOES OUT, not after it comes back. The server answers about the
    // moment it was asked, so anything this device creates from here on is newer than the answer
    // whatever order the two happen to complete in.
    const epochAtRequest = creationEpoch;
    const backendWorkspaces = await service.listUserWorkspaces();
    const validChannelConversationIds: string[] = [];
    const validWorkspaceSlugs = new SvelteSet<string>();

    for (const workspace of backendWorkspaces) {
      const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
      const workspaceId = sidebarWorkspace.workspaceDbId;
      if (!workspaceId) continue;
      validWorkspaceSlugs.add(sidebarWorkspace.id);

      // Joining the community's Graine key-distribution group is done HERE, and AWAITED, for a
      // reason beyond tidiness: it is what registers the group id locally, and until it is
      // registered a seed frame arriving on that group is treated as an unknown conversation and
      // answered with a welcome_request nobody will ever send. Awaiting closes that window instead
      // of leaving one spurious recovery per community per start.
      //
      // Never fatal to the load: a community that fails to prepare must still appear in the
      // sidebar, and its salons then refuse to SEND with a named cause rather than the whole
      // community vanishing. The failure is logged with its cause by
      // `ensureCommunityDistributionGroup`, which is all a best-effort path leaves behind.
      if (ctx.ensureMls) {
        const mls = await ctx.ensureMls();
        await ensureCommunityDistributionGroup(mls, service, workspaceId, ctx.log);
      }

      const channels = await service.listChannels(workspaceId);
      for (const channel of channels as ChannelDto[]) {
        const actualId = channel.id || channel._id;
        if (!actualId) continue;

        const isPrivate = channel.visibility === 'private';

        // Which group a salon's seeds travel on is the one fact the send path cannot derive: a
        // channel id alone reaches every send site, and the seal needs the roster the seed is
        // sealed to - the community for a public salon, the salon itself for a private one.
        registerChannelWorkspace(actualId, workspaceId, isPrivate);

        // A PRIVATE SALON HAS ITS OWN GROUP, and this is where this device enters it. Skipped when
        // the viewer only SEES the salon (an admin who has not joined): the route would refuse
        // them its GroupInfo, which is exactly what makes that roster finite.
        if (isPrivate && channel.viewerHasAccess !== false && ctx.ensureMls) {
          const mls = await ctx.ensureMls();
          await ensureDistributionGroupFor(
            mls,
            service,
            channelScope(workspaceId, actualId),
            ctx.log
          );
        }

        const channelConversationId = `channel_${actualId}`;
        if (!validChannelConversationIds.includes(channelConversationId)) {
          validChannelConversationIds.push(channelConversationId);
        }
        addChannelToWorkspace(sidebarWorkspace.id, {
          id: channelConversationId,
          name: channel.name,
          isPrivate,
          hasAccess: channel.viewerHasAccess !== false,
          canWrite: channel.viewerCanWrite !== false,
        });

        // AN UNJOINED SALON GETS NO CONVERSATION, and that is the point: a conversation row is what
        // every read path keys off, and this viewer may not read it. The sidebar row exists so the
        // join is reachable, and the join is what turns it into a conversation.
        if (channel.viewerHasAccess === false) continue;

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

    // NEWER THAN THE QUESTION IS NOT ABSENT FROM THE ANSWER. A salon created while this listing
    // was in flight is missing from it by construction, and deleting it here destroys a salon the
    // user is very probably typing in.
    const bornAfterTheRequest = (id: string) =>
      (locallyCreatedChannels.get(id) ?? 0) > epochAtRequest;
    const staleLocalChannelIds = Array.from(ctx.conversations.keys()).filter(
      (id) =>
        isChannelConversationId(id) &&
        !validChannelConversationIds.includes(id) &&
        !bornAfterTheRequest(id)
    );
    const sparedChannels = Array.from(ctx.conversations.keys()).filter(
      (id) =>
        isChannelConversationId(id) &&
        !validChannelConversationIds.includes(id) &&
        bornAfterTheRequest(id)
    );
    if (sparedChannels.length > 0) {
      ctx.log(
        `[WORKSPACE-LOAD] kept ${sparedChannels.length} salon(s) created after this listing was requested`
      );
    }
    for (const staleId of staleLocalChannelIds) {
      ctx.invalidateChannelHistoryCache?.(staleId);
      ctx.conversations.delete(staleId);
      removeChannelFromWorkspaces(staleId);
      if (selectedChannelConversationId === staleId) {
        selectedChannelConversationId = '';
      }
      await ctx.deleteConversation?.(staleId).catch(() => {});
    }

    // Prune workspaces that no longer exist on the server - EXCEPT the ones that did not exist
    // when this listing was requested, which are missing from it for a reason that is not deletion.
    const spared = channelWorkspaces.filter(
      (ws) => !validWorkspaceSlugs.has(ws.id) && (ws.createdEpoch ?? 0) > epochAtRequest
    );
    if (spared.length > 0) {
      ctx.log(
        `[WORKSPACE-LOAD] kept ${spared.length} community(ies) created after this listing was requested: ` +
          spared.map((ws) => ws.id).join(', ')
      );
    }
    channelWorkspaces = channelWorkspaces.filter(
      (ws) => validWorkspaceSlugs.has(ws.id) || (ws.createdEpoch ?? 0) > epochAtRequest
    );
  }

  /**
   * Extracts an HTTP status code, a stable refusal `code` and a human-readable detail from a raw
   * API error body. Handles NestJS JSON error envelopes ({ statusCode, code, message }) and
   * plain-text bodies, so callers can distinguish 401 (session) from 403 (permission) and surface
   * the real reason.
   */
  function parseApiError(raw: string): { status?: number; code?: string; detail: string } {
    try {
      const body = JSON.parse(raw) as {
        statusCode?: number;
        code?: string;
        message?: string | string[];
        error?: string;
      };
      const detail = Array.isArray(body.message)
        ? body.message.join(', ')
        : (body.message ?? body.error ?? raw);
      return { status: body.statusCode, code: body.code, detail };
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
    const { status, code, detail } = parseApiError(raw);

    // A typed refusal is answered from its code, before any of the prose matching below runs.
    const coded = describeCommunityRefusal(code);
    if (coded) {
      if (toast) showToast(coded, 'error');
      return coded;
    }

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

  /**
   * Records a community's history rule in the Graine layer and returns the narrowed value.
   *
   * The rule reaches the sidebar and the seed layer from the same read, because they must never
   * disagree: the modal showing "shared" while this device answers a joiner with nothing is a
   * divergence no log would ever name.
   */
  function adoptHistoryVisibility(
    workspaceId: string | undefined,
    visibility: string
  ): GraineHistoryVisibility {
    if (!workspaceId) return narrowHistoryVisibility(visibility);
    return registerCommunityHistoryVisibility(workspaceId, visibility);
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
      if (workspace.historyVisibility !== undefined) {
        existing.historyVisibility = adoptHistoryVisibility(
          workspaceId,
          workspace.historyVisibility
        );
      }
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
      historyVisibility:
        workspace.historyVisibility === undefined
          ? undefined
          : adoptHistoryVisibility(workspaceId, workspace.historyVisibility),
      channels: [],
    };
    channelWorkspaces = [...channelWorkspaces, created];
    return created;
  }

  /**
   * Puts a channel into the sidebar entry for `workspaceSlug`, REFRESHING one already there.
   *
   * **It used to ignore a channel it already had, and that silently discarded every reload.** The
   * full re-read from the server calls this for each channel it just fetched, so an entry already
   * on screen kept whatever it was created with for the rest of the session. What that hid was the
   * administrator join: `joinPrivateChannelAsAdmin` re-reads deliberately - "joining changes what
   * four different routes will answer for this salon" - the server answered `viewerHasAccess: true`,
   * and the row went on offering "Rejoindre" for ever, because it was already in the list. Found on
   * prod by COMM-13, whose four other assertions all passed: the join was complete everywhere
   * except on the screen of the person who performed it.
   *
   * **Merged rather than replaced.** The caller's fields win and the ones it does not mention are
   * kept - `unreadCount` is owned by the live event path and is not part of any reload, so a blind
   * overwrite would clear every unread badge each time the workspaces were re-read.
   *
   * The entry keeps its POSITION, so a refresh never reorders the sidebar under the reader.
   */
  function addChannelToWorkspace(workspaceSlug: string, channel: ChannelSidebarItem) {
    const idx = channelWorkspaces.findIndex((item) => item.id === workspaceSlug);
    if (idx === -1) return;
    const workspace = channelWorkspaces[idx];
    const at = workspace.channels.findIndex((item) => item.id === channel.id);
    const channels =
      at === -1
        ? [...workspace.channels, channel]
        : workspace.channels.map((item, i) => (i === at ? { ...item, ...channel } : item));

    channelWorkspaces = [
      ...channelWorkspaces.slice(0, idx),
      { ...workspace, channels },
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
   * Records where a channel the user was just added to in-session belongs, and enters its group.
   *
   * The real-time `channel.member.joined` event registers the channel in `conversations`, and until
   * this runs the send path knows no community for it - so the first message typed into a
   * freshly-joined salon would be refused with `GraineUnknownChannelError` until an app relaunch
   * ran the full `loadChannelWorkspacesFromBackend` pass. Safe to call again.
   */
  /**
   * Enters a private salon this administrator can SEE but has not joined.
   *
   * The capability that replaced the silent bypass. `workspace.manage` used to make every private
   * salon readable while putting the admin in none of their rosters, which made those rosters
   * infinite - `allowedUsers` plus whoever happened to hold an admin role - and an infinite roster
   * cannot be an MLS group. So the join is explicit, visible in the member list, and silent in the
   * transcript (the user's decision of 2026-08-19).
   *
   * The reload afterwards is deliberate rather than a local flag flip: joining changes what four
   * different routes will answer for this salon, and re-reading is the only way the sidebar,
   * the conversation entry and the seed group all come from the same server state.
   */
  async function joinPrivateChannelAsAdmin(
    channelConversationId: string,
    channelName: string,
    ctx: ChannelWorkspaceContext
  ): Promise<void> {
    try {
      await service.joinPrivateChannelAsAdmin(channelConversationId);
    } catch (e) {
      ctx.log?.(toUiActionError(m.chat_channel_join_as_admin_failed({ name: channelName }), e));
      return;
    }

    showToast(m.chat_channel_join_as_admin_done({ name: channelName }), 'info');
    await loadChannelWorkspacesFromBackend(ctx);
  }

  async function registerJoinedChannel(
    channelId: string,
    workspaceId: string,
    isPrivate: boolean,
    ensureMls?: () => IMlsService | Promise<IMlsService>
  ): Promise<void> {
    if (!channelId || !workspaceId) return;
    registerChannelWorkspace(channelId, workspaceId, isPrivate);

    // A PRIVATE SALON JOINED IN-SESSION NEEDS ITS GROUP BEFORE THE FIRST SEND, exactly as one
    // loaded at startup does, and nothing else would fetch it until the next full reload - the
    // same window this function was written to close for the channel-to-community map.
    if (!isPrivate || !ensureMls) return;
    const mls = await ensureMls();
    await ensureDistributionGroupFor(mls, service, channelScope(workspaceId, channelId), (m) =>
      console.info(m)
    );
  }

  // ---------- API operations ----------

  /**
   * Fetches all workspaces and their channels from the backend, hydrates channel encryption keys,
   * and prunes stale local channel entries.
   *
   * Resolves to false when it declined because a load was already in flight - callers that refetch
   * to resolve one specific channel (the deep-link landing) must know their request was dropped,
   * or a join racing the startup load waits forever for a refresh that never ran.
   *
   * An attempt that ran and failed still resolves to true, but leaves `workspacesLoadError` set:
   * "a refresh ran" and "the list is current" are two different facts, and a caller that treats the
   * first as the second empties the sidebar on one dropped request. The list itself is never
   * cleared by a failure - it is replaced only by a response that actually arrived.
   */
  async function loadChannelWorkspacesFromBackend(ctx: ChannelWorkspaceContext): Promise<boolean> {
    if (isLoadingWorkspaces) return false;
    isLoadingWorkspaces = true;
    workspacesLoadError = null;

    try {
      for (let attempt = 0; attempt <= WORKSPACE_LOAD_RETRY_DELAYS.length; attempt++) {
        try {
          await executeWorkspaceLoadAttempt(ctx);
          workspacesLoadError = null;
          ctx.log(`[WORKSPACE-LOAD] communities/channels loaded (attempt ${attempt + 1})`);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const attemptCount = WORKSPACE_LOAD_RETRY_DELAYS.length + 1;
          ctx.log(`[WORKSPACE-LOAD] attempt ${attempt + 1}/${attemptCount} failed: ${message}`);

          const status = parseApiError(message).status;
          // 401/403 are not transient: retrying them hammers the backend and the session still
          // needs refreshing, so they exit on the first attempt like any non-retryable error.
          const isFatal = status === 401 || status === 403 || !isRetryableLoadError(error);
          const isLastAttempt = attempt === WORKSPACE_LOAD_RETRY_DELAYS.length;

          if (isFatal || isLastAttempt) {
            workspacesLoadError = toUiActionError(m.channel_action_community_load(), error, false);
            ctx.log(
              `[WORKSPACE-LOAD] giving up (${isFatal ? 'non-retryable' : 'retries exhausted'}) - existing community list preserved: ${workspacesLoadError}`
            );
            return true;
          }

          const delay = WORKSPACE_LOAD_RETRY_DELAYS[attempt];
          ctx.log(`[WORKSPACE-LOAD] retryable failure - next attempt in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      // Unreachable: the final attempt always returns from the catch above.
      return true;
    } finally {
      isLoadingWorkspaces = false;
    }
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
    // STAMPED THE MOMENT IT EXISTS LOCALLY, and before any of the awaits below: a listing already
    // in flight cannot know about it, and this is what stops that listing from deleting it.
    sidebarWorkspace.createdEpoch = ++creationEpoch;
    const workspaceId = sidebarWorkspace.workspaceDbId;

    // THE CREATOR PREPARES ITS OWN COMMUNITY, and until 2026-08-20 nothing did. Creating a community
    // selects its default salon and leaves the composer ready, and a public salon seals its seeds to
    // the COMMUNITY's group - which this device did not hold, because the only two places that
    // ensured it were the workspace LOAD and the creation of a PRIVATE salon. So the first message
    // anyone sends in a community they just made was refused outright, with "community <id> has no
    // distribution group on this device": create, type, fail.
    //
    // It healed, which is what kept it hidden. A reload runs the load path, and a second member
    // joining publishes the base the creator then joins - so the defect only survives in the window
    // where the creator is alone and has not reloaded, which is precisely the minute after they
    // press the button. COMM-1's first completed run is what caught it.
    //
    // Awaited and placed BEFORE the channels are listed, for the reason the load path gives at its
    // own call: a seed frame arriving on a group this device has not registered is answered as an
    // unknown conversation. Never fatal - a community that fails to prepare must still appear in the
    // sidebar, and `ensureCommunityDistributionGroup` logs the cause.
    if (workspaceId && ctx.ensureMls) {
      const mls = await ctx.ensureMls();
      await ensureCommunityDistributionGroup(mls, service, workspaceId, ctx.log);
    }

    // Immediately load the channels the backend created (e.g. the default "general" channel)
    // so the sidebar populates without requiring a page reload.
    if (workspaceId) {
      try {
        const channels = await service.listChannels(workspaceId);
        for (const channel of channels as ChannelDto[]) {
          const actualId = channel.id || channel._id;
          if (!actualId) continue;

          registerChannelWorkspace(actualId, workspaceId, channel.visibility === 'private');

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

      const isPrivate = visibility === 'private';
      // Same stamp as a community, for the same window and the same prune.
      locallyCreatedChannels.set(channelId, ++creationEpoch);
      registerChannelWorkspace(actualId, workspaceId, isPrivate);

      // The salon was created private, so social-service has already minted its group; this device
      // is the one that initialises the MLS state on it, and it must do so before the first send.
      if (isPrivate && ctx.ensureMls) {
        const mls = await ctx.ensureMls();
        await ensureDistributionGroupFor(
          mls,
          service,
          channelScope(workspaceId, actualId),
          ctx.log
        );
      }

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
      await service.inviteToChannel(channelId, {
        targetUserId: memberId,
        roleName: backendRoleName,
      });

      if (ctx.ensureMls && ctx.startDirectConversation) {
        const previousSelection = ctx.getSelectedConversationId?.() ?? null;
        try {
          await ctx.startDirectConversation(memberId, { silent: true });
          const directConvo = Array.from(ctx.conversations.entries()).find(([, convo]) => {
            if ((convo.conversationType ?? 'group') !== 'direct') return false;
            return (convo.directPeerId ?? convo.contactName).toLowerCase() === memberId;
          });

          if (directConvo) {
            const mlsService = await ctx.ensureMls();

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
                  { isSystem: true, messageId: channelInviteMessageId(channelId, memberId) }
                );
              } catch (err) {
                console.warn('[Channel Invite] Failed to send invitation message:', err);
              }
            }
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
   * Drops a workspace from local state: its Graine seeds are erased, its channels leave the
   * conversations map and local storage, the workspace leaves the sidebar, and the selection is
   * cleared if it pointed inside. Shared by the four ways a community can disappear - leaving it,
   * deleting it, being removed from it, and receiving the `workspace.deleted` broadcast for
   * someone else's deletion.
   *
   * The seeds go FIRST, and they are the reason this is one function rather than four: they are
   * the only thing here that is key material, and a device keeping them for a community it can no
   * longer list is residue nothing else would ever come back for.
   */
  async function purgeWorkspaceLocally(workspaceDbId: string, ctx: WorkspacePurgeContext) {
    await forgetCommunityGraine(workspaceDbId);
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
   *
   * `confirmationName` is the name the admin typed into the dialog. It is carried all the way to
   * the server, which refuses the deletion unless it matches - so it must never be filled in from
   * the workspace the caller already has, only from what a human actually typed.
   */
  async function deleteCurrentWorkspace(
    workspaceDbId: string,
    confirmationName: string,
    ctx: ChannelWorkspaceContext
  ) {
    if (!workspaceDbId) return;
    try {
      await service.deleteWorkspace(workspaceDbId, confirmationName);
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
   * Places or takes back the caller's emoji reaction on a channel message.
   *
   * **The reaction IS the message (WP-40).** It is sealed under this device's Graine session and
   * stored by the server as an opaque blob, so the server no longer counts who reacted with what -
   * it used to hold that tally in cleartext, which is content by any honest reading.
   *
   * The local merge comes FIRST and with the same `at` the frame carries, so the pill flips at
   * once and this device's own row, when it comes back, merges to exactly the same state. There is
   * no rollback on failure and none is possible: what a send failure costs is the peers' copy, and
   * a device that unflipped its own pill would disagree with the frame it may still have sent.
   */
  async function toggleChannelReaction(
    channelConversationId: string,
    messageId: string,
    emoji: string,
    ctx: ChannelWorkspaceContext
  ) {
    const userId = currentUserId();
    if (!channelConversationId || !messageId || !emoji || !userId) return;

    const held = getChannelReactions(messageId);
    const standing = activeReactions(held).some(
      (r) => r.userId === userId.toLowerCase() && r.emoji === emoji
    );
    // The distinct-emoji cap belongs where the user ACTS, never in the merge: a frame that arrived
    // is something the community did, and a device that refused it would drift from one that
    // accepted it.
    if (!standing && !canAddDistinctReactionEmoji(held, emoji)) {
      ctx.log(
        `[CHANNEL] reaction refused: ${MAX_DISTINCT_MESSAGE_REACTIONS} distinct emoji already`
      );
      return;
    }

    const at = Date.now();
    applyChannelReactionFrame(messageId, userId, emoji, at, standing);
    try {
      await sendChannelReaction(channelConversationId, messageId, emoji, at, standing);

      // NOTIFY THE AUTHOR, AND NOBODY ELSE. The reaction itself is sent silent - a heart must not
      // ring every phone in the community - so this targeted push is the only notification there
      // is. It concerns the person reacted to, and telling a whole channel about each one is
      // exactly the noise a busy community cannot afford. Nothing of the message crosses; the
      // author's own devices hold it already (see `notifyReaction`).
      const author = ctx.conversations
        .get(channelConversationId)
        ?.messages.find((msg) => msg.id === messageId)?.senderId;
      if (!standing && author && author !== userId) {
        const getName = await resolveDisplayNames([userId]);
        void notifyReaction({
          groupId: channelConversationId,
          targetSenderId: author,
          emoji,
          messageId,
          actorName: getName(userId),
        }).catch(() => {});
      }
    } catch (error) {
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

  /**
   * Applies a community-wide `channel.member.kicked` broadcast addressed to this user: an admin
   * removed them from the workspace. The local effect is the same as the community being deleted
   * - it is gone from the sidebar and its channels leave the conversations map - which is why
   * both go through {@link purgeWorkspaceLocally}. The caller must have already checked that the
   * removed user is the local one.
   */
  async function handleRemovedFromWorkspace(
    event: { workspaceId?: string },
    ctx: WorkspacePurgeContext
  ) {
    if (!event.workspaceId) return;
    ctx.log(`[Channel Event] removed from community ${event.workspaceId.slice(0, 8)}`);
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

  /**
   * Applies an incoming real-time workspace-updated event (cover image, history rule).
   *
   * The history rule is applied to the Graine layer too, and not only to the sidebar: a member
   * still holding `shared` in memory would keep handing the past to joiners after an admin had
   * closed it, until their next relaunch.
   */
  /**
   * Applies this device's own new role in a community, pushed by the server.
   *
   * ONE FLAG IS ALL THE CLIENT CACHES, and it is stated rather than re-derived: `viewerCanManage`
   * comes from `listWorkspacesForUser`, which reads the permission set of the roles a member holds.
   * The event carries the same answer computed by the same service, so applying it here cannot
   * disagree with what the next load will say.
   *
   * WHY IT IS NOT A REFETCH. A refetch can fail, can be declined because a load is already in
   * flight, and lands whenever the network allows - and what it would return is precisely the value
   * that is already in the event. The demoted administrator this exists for must lose the controls
   * at the moment they lose the role, not at the moment a round trip completes.
   *
   * The whole permission list is accepted and deliberately unused: the day a second permission is
   * cached on this side, the data is already here and only this function changes.
   */
  function handleWorkspaceRoleChanged(event: {
    workspaceId: string;
    roleName: string;
    canManage: boolean;
    permissions: string[];
  }) {
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.workspaceDbId === event.workspaceId ? { ...ws, viewerCanManage: event.canManage } : ws
    );
  }

  /**
   * What each workspace role currently grants, keyed by role id.
   *
   * HELD HERE RATHER THAN IN THE PANEL because a role's permissions change under an open grid: two
   * administrators can be looking at the same table, and until 2026-08-20 the one whose edit was not
   * the last one kept a grid showing a state the server had never had (COMM-20). The panel fills
   * this when it loads and reads it back, so an announcement from the server reaches the screen with
   * no round trip and no second copy of the state.
   *
   * Keyed by role id and NOT scoped by workspace: role ids are uuids, and the panel replaces the map
   * wholesale when it opens a different community.
   */
  let rolePermissions = $state<Record<string, string[]>>({});

  /** Replaces everything known about roles - what the panel does when it loads a community. */
  function setRolePermissions(all: Record<string, string[]>) {
    rolePermissions = { ...all };
  }

  /**
   * Applies what a role grants NOW, from the server: either its own answer to an edit, or the
   * announcement of somebody else's.
   */
  function handleRolePermissionsChanged(event: { roleId: string; permissions: string[] }) {
    if (!event.roleId) return;
    rolePermissions = { ...rolePermissions, [event.roleId]: [...event.permissions] };
  }

  function handleWorkspaceUpdated(event: {
    workspaceId: string;
    imageMediaId?: string;
    historyVisibility?: string;
  }) {
    const visibility =
      event.historyVisibility === undefined
        ? undefined
        : adoptHistoryVisibility(event.workspaceId, event.historyVisibility);
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.workspaceDbId === event.workspaceId
        ? {
            ...ws,
            imageMediaId: event.imageMediaId ?? ws.imageMediaId,
            historyVisibility: visibility ?? ws.historyVisibility,
          }
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
    /** True while the workspace/channel list is being fetched. */
    get isLoadingWorkspaces() {
      return isLoadingWorkspaces;
    },
    /** User-facing error message if the last workspace load failed, or null. */
    get workspacesLoadError() {
      return workspacesLoadError;
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
    /** Records the community of a channel the user was just added to in-session (no relaunch needed). */
    registerJoinedChannel,
    /** Enters a private salon an admin can see but has not joined, then re-reads the community. */
    joinPrivateChannelAsAdmin,
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
    handleWorkspaceRoleChanged,
    /** What each workspace role grants right now, keyed by role id - see the state's own note. */
    get rolePermissions() {
      return rolePermissions;
    },
    setRolePermissions,
    /** Applies an incoming real-time change to what a role grants (this device's or anybody's). */
    handleRolePermissionsChanged,

    handleWorkspaceUpdated,
    /** Applies an incoming real-time workspace-deleted event (an admin deleted the community). */
    handleWorkspaceDeleted,
    /** Applies an incoming real-time removal of THIS user from a community (admin kick). */
    handleRemovedFromWorkspace,
    /** Deletes a channel message (own message, or anyone's with `channel.moderate`). */
    deleteChannelMessage,
    /** Toggles the caller's emoji reaction on a channel message. */
    toggleChannelReaction,
    /** Applies an incoming real-time channel-message-deleted event. */
    handleChannelMessageDeleted,
  };
}
