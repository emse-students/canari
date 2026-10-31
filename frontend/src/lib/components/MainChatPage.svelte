<script module lang="ts">
  // Last routeMode ('chat' | 'communities') that MainChatPage mounted under. Module-scoped so it
  // survives the component remount that happens when navigating between the /chat and /communities
  // routes (each is a distinct +page.svelte rendering its own MainChatPage). A component-local
  // $state would reset to null on every mount, so a mode switch could never be detected and the
  // previous discussion's content leaked across tabs.
  let lastActiveRouteMode: 'chat' | 'communities' | null = null;
</script>

<script lang="ts">
  import { resolveConversationListPresentation } from '$lib/utils/chat/conversations';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { foldForSearch } from '$lib/utils/textFold';
  import { goto } from '$app/navigation';
  import { fade } from 'svelte/transition';
  import { m } from '$lib/paraglide/messages';
  import { showToast } from '$lib/stores/toast.svelte';
  import { flushOwedDmReadMarks } from '$lib/utils/chat/messaging';
  import { recordUnsentSalonText } from '$lib/utils/chat/salonUnsent';
  import { restoreFailedDraft } from '$lib/utils/chat/draftRestore';
  import { createHeldSendQueue } from '$lib/utils/chat/heldSends';
  import { isAppInForeground, onAppScreenChange } from '$lib/utils/appForeground';
  import { readMarkTarget, watermarkFor, withOwnReadAdvanced } from '$lib/utils/chat/readState';
  import { createReadMarkDebounce } from '$lib/utils/chat/readMarkDebounce';
  import { publishConversationRead } from '$lib/mls-client/tabMessageSync';
  import { forceSyncReset } from '$lib/utils/chat/actions';
  import {
    CHANNEL_CONVERSATION_PREFIX,
    isChannelConversationId,
    sendChannelPoll,
    type ChannelPollDraft,
  } from '$lib/utils/chat/channelCrypto';
  import { channelService } from '$lib/services/ChannelService';
  import {
    flushSalonReadMarks,
    forgetDmReadMark,
    owedDmReadMarks,
    recordDmReadMark,
    recordSalonReadMark,
  } from '$lib/utils/chat/salonReadMarkQueue';
  import {
    loadControlRefusals,
    setControlRetryExecutor,
  } from '$lib/utils/chat/controlRefusals.svelte';
  import { setJoinRequestHandlers } from '$lib/utils/chat/joinRequests.svelte';
  import { describeApiRefusal, refusalStatus } from '$lib/utils/apiRefusal';
  import { mayPinMessage } from '$lib/utils/chat/pinPermission';
  // NOT from `CallService`: calling is held off, and naming its error type here would pull the
  // whole service into this page's module graph for a `catch` - see `callFailure.ts`.
  import { describeCallFailure } from '$lib/utils/callFailure';
  import { afterNextPaint } from '$lib/utils/afterNextPaint';
  import {
    claimChannelReadSignal,
    newestForeignMessageAt,
  } from '$lib/utils/chat/channelReadSignal';
  import { applyLocalVote, getPollMeta, setPollMeta } from '$lib/stores/pollStore.svelte';
  import { deliverSalonWrite, nothingLeftTheDevice } from '$lib/utils/chat/salonOwed';
  import { channelReactionMap } from '$lib/stores/reactionStore.svelte';
  import { aggregateSharedContent, type SharedContent } from '$lib/utils/chat/sharedContent';
  import { getPreviewText, parseEnvelope } from '$lib/envelope';
  import { isMessagePinned, applyPin, setPinnedSet } from '$lib/stores/pinStore.svelte';
  import {
    globalSession as session,
    globalConvs as convs,
    globalMessaging as messaging,
    globalChannels as channels,
    globalNotifs as notifs,
    appendLog,
  } from '$lib/stores/globalChatSingleton.svelte';
  import { openInvitedChannel, selectionBelongsToRoute } from '$lib/utils/chat/notificationRouting';
  import { notifNav } from '$lib/stores/notifNav.svelte';
  import { incomingShare, type SharedFileEntry } from '$lib/stores/incomingShare.svelte';
  import { stageSharedFiles } from '$lib/mobile/incomingShareDrain';
  import { discardSharedFiles } from '$lib/mobile/sharedInbox';
  import { MediaService } from '$lib/media';
  import { signOutGeneration } from '$lib/stores/auth';
  import { resolveConversationKey } from '$lib/utils/chat/openConversationFromId';
  import { currentUserId } from '$lib/stores/userState.svelte';
  import { unlockUnattendedFor } from '$lib/stores/unlockPath.svelte';
  import Sidebar from './sidebar/Sidebar.svelte';
  import ChannelMembersList from './chat/ChannelMembersList.svelte';
  import ChatGroupPanel from './chat/ChatGroupPanel.svelte';
  import ChannelSettingsPanel from './chat/ChannelSettingsPanel.svelte';
  import ConversationMediaPanel from './chat/ConversationMediaPanel.svelte';
  import ConversationSidePanel from './chat/ConversationSidePanel.svelte';
  import ChatArea from './chat/ChatArea.svelte';
  import MessagingSyncOverlay from './chat/MessagingSyncOverlay.svelte';
  import ForwardMessageModal from './chat/ForwardMessageModal.svelte';
  import { callsAvailable, callVideoAvailable } from '$lib/utils/callsAvailability';
  import { serverCallsMode } from '$lib/stores/appVersionCheck.svelte';
  import type {
    AddMessageToChatOptions,
    ChatMessage,
    Conversation,
    MessageBatchOrigin,
  } from '$lib/types';
  import type { BulkIngestPhase } from '$lib/mls-client';

  interface Props {
    /** Controls whether the sidebar shows private chat conversations or community channels. */
    routeMode?: 'chat' | 'communities';
  }

  let { routeMode = 'chat' }: Props = $props();

  /** True when the currently selected conversation is a channel (not an MLS DM or group). */
  const isSelectedChannel = $derived(isChannelConversationId(convs.selectedContact ?? ''));

  /**
   * Channel reactions come from their own store, because they are a cleartext server-side tally
   * rather than the encrypted MLS system messages a DM reaction is made of.
   */
  const channelReactions = channelReactionMap();

  /**
   * Whether the viewer may delete OTHER members' messages in the open channel - the
   * `channel.moderate` permission the community role matrix advertises. Server-authoritative
   * (`viewerCanModerate`) and fail-closed; the API re-checks it, so this only decides whether
   * the delete affordance is worth offering. Always false outside a channel: in a DM or group,
   * deletion stays limited to your own messages.
   */
  const canModerateSelectedChannel = $derived(
    isSelectedChannel &&
      (channels.channelWorkspaces.find((ws) =>
        ws.channels.some((ch) => ch.id === convs.selectedContact)
      )?.viewerCanModerate ??
        false)
  );

  /**
   * Whether the viewer may POST in the open channel - the salon's `writePolicy` applied to their own
   * roles, as the server decided it (`viewerCanWrite`).
   *
   * Fails OPEN, unlike {@link canModerateSelectedChannel}, and the asymmetry is deliberate: a
   * moderation affordance offered by mistake costs a refused request, while a composer withheld by
   * mistake costs the person the ability to speak. The server refuses a forbidden post either way -
   * this only decides whether the product offers a control it would refuse.
   */
  const canWriteToSelectedChannel = $derived(
    !isSelectedChannel ||
      (channels.channelWorkspaces
        .flatMap((ws) => ws.channels)
        .find((ch) => ch.id === convs.selectedContact)?.canWrite ??
        true)
  );

  /** Member user IDs of the currently selected channel, for scoping @mention suggestions. */
  let selectedChannelMemberIds = $state<string[]>([]);

  /** True while MLS unlock / queue catch-up is running. */
  const isSyncing = $derived(session.isMessagingInitializing || messaging.isMessageCatchupActive);

  /** True once at least one conversation is restored from local cache. */
  const hasCachedConversations = $derived(convs.conversations.size > 0);

  /**
   * Block the whole UI only on a cold start (nothing cached yet). Once cached conversations are
   * available we show them immediately and sync in the background.
   *
   * This used to claim "the per-group scheduler serializes sends safely meanwhile", which is not
   * what makes it safe: `sendMessage` goes straight to the WASM client and takes no scheduler lock -
   * that mutex wraps the INBOUND drain. What actually protects a send made during a drain is the
   * outbox flusher's `waitForMessageQueueIdle` barrier, which is what stops a message being
   * encrypted at a stale epoch and silently dropped by up-to-date peers.
   */
  /**
   * The notification landing's target, drawn from the local store while the session is not up yet
   * (F1, `landingPreview.ts`). The page is shown for it, read-only but for the composer, whose sends
   * are held until the session is up ({@link whenSessionUp}).
   */
  const isLocalPreview = $derived(!session.isLoggedIn && convs.landingPreviewKey !== null);

  /**
   * The Communities page drawing the account's community list before the session is up (F1, the
   * saved snapshot or a listing started on the token): the rail and the salon rows are shown, and
   * what would ACT waits for the session (`previewOnly`, {@link landOnSalonOnceOpenable}).
   *
   * Only for the signed-in account's own list, and only while its unlock prompts NOBODY (a vault or
   * keystore key in hand, {@link unlockUnattendedFor}): a device that owes a PIN or a fingerprint is
   * locked, and a lock screen shows nothing of what it locks - before its prompt is drawn, while it
   * is up, and after it is left for another page.
   */
  const isWorkspacePreview = $derived(
    !session.isLoggedIn &&
      routeMode === 'communities' &&
      unlockUnattendedFor() !== null &&
      unlockUnattendedFor() === currentUserId() &&
      channels.channelWorkspaces.length > 0 &&
      channels.workspacesOwner !== null &&
      channels.workspacesOwner === currentUserId()
  );

  /**
   * The communities page has rows to show from the device: the sync overlay must not hide them. It
   * blocked the screen "on a cold start (nothing cached yet)", and counted only conversations - so a
   * rail drawn from the snapshot was covered until the first DM or salon row existed.
   */
  const drawsLocalCommunities = $derived(
    routeMode === 'communities' && channels.channelWorkspaces.length > 0
  );

  const isMessagingBlocked = $derived(
    (!session.isLoggedIn && !isLocalPreview && !isWorkspacePreview) ||
      (isSyncing && !hasCachedConversations && !drawsLocalCommunities)
  );

  /**
   * The list on screen is not yet the server's (the saved snapshot), and no listing has failed: it
   * is being refreshed, and the sidebar says so. After a give-up the error is the statement.
   */
  const communitiesRefreshing = $derived(
    drawsLocalCommunities && !channels.workspacesConfirmed && channels.workspacesLoadError === null
  );

  const messagingOverlayMessage = $derived(
    !session.isLoggedIn ? m.chat_connecting_label() : m.chat_sync_overlay_message()
  );

  /** Explicit derived binding so ChatArea re-renders when the open conversation mutates. */
  const activeConversation = $derived(convs.currentConvo);

  /**
   * The open conversation's presentation, resolved the SAME way the list and the thread header
   * resolve it - through `resolveConversationListPresentation`, not by reading fields off the
   * record. A DM's `name` is not the peer's name, so a second derivation here would put a different
   * title on the panel than on the row that opened it.
   */
  const activeView = $derived.by(() => {
    const c = activeConversation;
    if (!c?.id) return null;
    const pres = resolveConversationListPresentation(
      {
        id: c.id,
        name: c.name,
        contactName: c.contactName ?? c.id,
        conversationType: c.conversationType,
        directPeerId: c.directPeerId,
      },
      session.userId ?? ''
    );
    return {
      displayName: pres.displayName,
      contactName: c.contactName ?? pres.contactId,
      isGroup: (c.conversationType ?? 'group') === 'group',
    };
  });

  /**
   * WHICH side panel to draw, after the two cases where the state is stale rather than wrong.
   *
   * `sidePanel` survives a conversation switch only long enough for the next render, and members
   * and settings are channel-only. Reading the store directly would draw an empty members list for
   * a DM for one frame - so the guard is here, once, rather than repeated in each branch.
   */
  const sidePanelKind = $derived.by(() => {
    const kind = convs.sidePanel;
    if (!kind) return null;
    if ((kind === 'members' || kind === 'settings') && !isSelectedChannel) return null;
    if (kind === 'conversation' && isSelectedChannel) return null;
    return kind;
  });

  /** The panel's heading. A map, because the kinds are a closed set. */
  const sidePanelTitle = $derived(
    sidePanelKind === 'members'
      ? m.chat_channel_members_title()
      : sidePanelKind === 'media'
        ? m.chat_media_links_files_title()
        : sidePanelKind === 'settings'
          ? m.chat_channel_settings_title()
          : sidePanelKind === 'conversation'
            ? activeView?.isGroup
              ? m.chat_group_management_title()
              : m.chat_group_dm_info_title()
            : ''
  );

  /** The conversation the panels describe: a channel's own id, or the selected group's. */
  const selectedConversationId = $derived(activeConversation?.id ?? '');

  /** User IDs allowed in @mention suggestions for the active chat/channel, or undefined for unrestricted (e.g. posts). */
  const composerAllowedUserIds = $derived(
    isSelectedChannel
      ? selectedChannelMemberIds
      : convs.groupMembers.length > 0
        ? convs.groupMembers
        : undefined
  );

  // Deep-link landing (notification tap, invite card, invite link) is owned by
  // ChatBackgroundService: it reads the same globalConvs/globalChannels singletons, is mounted on
  // every route, and holds the target until it is displayed. A second copy here selected the
  // target and released it early, which is what let the landing be lost.

  // The open conversation's draft - each conversation keeps its own (`messaging.draftFor`), so a
  // text left in one never sits in the next one's composer.
  const messageText = $derived(messaging.draftFor(convs.selectedContact));

  /** Message pending forwarding (opens ForwardMessageModal when non-null). */
  let forwardingMessage = $state<ChatMessage | null>(null);
  let isWindowFocused = $state(true);
  let isTabVisible = $state(true);

  /**
   * The frame the log panel's scroll is already scheduled for, or `null`.
   *
   * ONE PER FRAME, NOT ONE PER LINE. Every function in this app logs at entry, at each decision and
   * on each error branch - that is the house rule - so a burst is dozens of `log()` calls inside a
   * single frame. Each one used to schedule a `tick()`, which FLUSHES Svelte's pending updates, and
   * then read and wrote layout on an element that is usually not even rendered. The panel can only
   * be seen once per frame, so it is scrolled once per frame.
   */
  let logScrollFrame: number | null = null;

  /** Appends a debug message to the global log buffer and scrolls the log panel. */
  function log(msg: string) {
    appendLog(msg);
    if (logScrollFrame !== null) return;
    logScrollFrame = requestAnimationFrame(() => {
      logScrollFrame = null;
      // A frame callback runs after Svelte's microtask flush, so it sees the same DOM `tick()` was
      // being awaited for - and costs nothing when the panel is closed and this returns null.
      const el = document.getElementById('logContainer');
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  /** Builds the context object passed to channel workspace composable operations. */
  function channelsCtx() {
    return {
      conversations: convs.conversations,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      deleteConversation: (name: string) =>
        session.storage?.deleteConversation(name) ?? Promise.resolve(),
      storedSalonPageIds: () =>
        session.storage?.getMessageConversationIds(CHANNEL_CONVERSATION_PREFIX) ??
        Promise.resolve([]),
      selectConversation: convs.selectConversation,
      ensureMls: async () => session.ensureMls(),
      startDirectConversation: (targetUserId: string, opts?: { silent?: boolean }) =>
        convs.startNewConversation(targetUserId, convCtx(), opts),
      getSelectedConversationId: () => convs.selectedContact,
      addMessageToChat: (
        sid: string,
        content: string,
        contactName: string,
        options?: AddMessageToChatOptions
      ) => messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      reloadChannelHistory: (channelConversationId: string) =>
        convs.loadHistoryForConversation(channelConversationId, channelConversationId, convCtx()),
      invalidateChannelHistoryCache: (channelConversationId: string) =>
        convs.invalidateChannelHistoryCache(channelConversationId),
      log,
    };
  }

  /** Builds the context object passed to conversation composable operations. */
  function convCtx() {
    return {
      storage: session.storage,
      ensureMls: session.ensureMls,
      userId: session.userId,
      deviceKeyB64: session.deviceKeyB64,
      historyBaseUrl: session.historyBaseUrl,
      messageReactions: messaging.messageReactions,
      log,
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      batchAddMessages: (
        msgs: Parameters<typeof messaging.batchAddMessages>[0],
        contactName: string,
        origin: MessageBatchOrigin
      ) => messaging.batchAddMessages(msgs, contactName, msgCtx(), origin),
    };
  }

  /** Builds the context object passed to messaging composable operations. */
  function msgCtx() {
    return {
      ensureMls: session.ensureMls,
      conversations: convs.conversations,
      userId: session.userId,
      deviceKeyB64: session.deviceKeyB64,
      authToken: session.authToken,
      setAuthToken: (v: string) => {
        session.authToken = v;
      },
      selectedContact: convs.selectedContact,
      getSendError: () => convs.sendError,
      setSendError: (v: string) => {
        convs.sendError = v;
      },
      storage: session.storage,
      log,
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      verifyCurrentUserMembership: (name: string) =>
        convs.verifyCurrentUserMembership(name, convCtx()),
      playNotificationTone: notifs.playNotificationTone,
      playSendTone: notifs.playSendTone,
      playReceiveTone: notifs.playReceiveTone,
      playReadTone: notifs.playReadTone,
      sendSystemNotification: notifs.sendSystemNotification,
      signalChannelRead: (channelId: string) => void channelService.markChannelRead(channelId),
    };
  }

  /** Builds the callbacks object passed to session composable operations (WebSocket event handlers). */
  function sessionCb() {
    return {
      conversations: convs.conversations,
      loadAndRestoreConversations: () => convs.loadAndRestoreConversations(convCtx()),
      invalidateRestores: () => convs.invalidateRestores(),
      forgetUnconfirmedSalonDraws: () => convs.forgetUnconfirmedSalonDraws(),
      beginConversationSource: () => convs.beginConversationSource(),
      endConversationSource: () => convs.endConversationSource(),
      addMessageToChat: (sid: string, content: string, contactName: string, options?: any) =>
        messaging.addMessageToChat(sid, content, contactName, msgCtx(), options),
      beginBulkMessageIngest: (phase: BulkIngestPhase) => messaging.beginBulkMessageIngest(phase),
      endBulkMessageIngest: (phase: BulkIngestPhase) =>
        messaging.endBulkMessageIngest(msgCtx(), phase),
      batchAddMessages: (
        msgs: Parameters<typeof messaging.batchAddMessages>[0],
        contactName: string,
        origin: MessageBatchOrigin
      ) => messaging.batchAddMessages(msgs, contactName, msgCtx(), origin),
      saveConversation: (name: string) => convs.saveConversation(name, convCtx()),
      selectConversation: convs.selectConversation,
      onSendError: (msg: string) => {
        convs.sendError = msg;
      },
      onReadStateAdvanced: (e: { conversationKey: string; senderId: string; at: number }) => {
        // Sound only when someone else reads MY message, in the currently open conversation
        // on the visible tab (never for my own cross-device reads).
        if (e.senderId === session.userId) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
        if (e.conversationKey !== convs.selectedContact) return;
        notifs.playReadTone();
      },
      log,
      messageReactions: messaging.messageReactions,
      getSelectedContact: () => convs.selectedContact,
      setSelectedContact: (v: string | null) => {
        convs.selectedContact = v;
      },
      onLoadHistoryForConversation: (contactName: string, groupId: string) =>
        convs.loadHistoryForConversation(contactName, groupId, convCtx()),
    };
  }

  /**
   * Returns the set of props shared by both the desktop sidebar and the mobile drawer sidebar.
   * Extracted here to avoid duplicating 20+ prop bindings in the template.
   */
  function makeSidebarCommonProps() {
    return {
      viewMode: (routeMode === 'communities' ? 'communities' : 'chat') as 'chat' | 'communities',
      conversations: convs.conversations,
      selectedContact: convs.selectedContact,
      newContactInput: convs.newContactInput,
      newGroupInput: convs.newGroupInput,
      newChannelInput: convs.newChannelInput,
      channelWorkspaces: channels.channelWorkspaces,
      selectedChannelId: channels.selectedChannelConversationId,
      currentUserId: session.userId,
      onContactInputChange: (v: string) => {
        convs.newContactInput = v;
      },
      onGroupInputChange: (v: string) => {
        convs.newGroupInput = v;
      },
      onChannelInputChange: (v: string) => {
        convs.newChannelInput = v;
      },
      // BOTH ANSWER, because the sidebar closes its creation panel on the answer. The input is
      // cleared here as before - the panel keeps its own copy of the text and decides, from the
      // outcome, whether to blank it.
      onAddContact: async (value?: string) => {
        const c = (value ?? convs.newContactInput).trim();
        if (!c) return { ok: true, key: null } as const;
        const outcome = await convs.startNewConversation(c, convCtx());
        convs.newContactInput = '';
        return outcome;
      },
      onCreateGroup: async (value?: string) => {
        const g = (value ?? convs.newGroupInput).trim();
        if (!g) return { ok: true, key: null } as const;
        const outcome = await convs.createNewGroup(g, convCtx());
        convs.newGroupInput = '';
        return outcome;
      },
      onCreateChannel: (workspaceId: string, value?: string, visibility?: 'public' | 'private') => {
        const ch = (value ?? convs.newChannelInput).trim();
        if (!ch) return;
        const ws = channels.channelWorkspaces.find((w) => w.id === workspaceId);
        if (ws?.workspaceDbId)
          channels.createNewChannel(ws.workspaceDbId, ch, channelsCtx(), visibility);
        convs.newChannelInput = '';
      },
      onCreateWorkspace: (value?: string) => {
        const wn = (value ?? '').trim();
        if (wn) channels.createNewCommunity(wn, channelsCtx());
      },
      onInviteChannelMember: (
        channelId: string,
        memberId: string,
        roleName: 'member' | 'moderator' | 'admin'
      ) => channels.inviteMemberToChannel(channelId, memberId, roleName, channelsCtx()),
      onUpdateWorkspaceImage: (workspaceDbId: string, mediaId: string) =>
        void channels.updateCurrentWorkspaceImage(workspaceDbId, mediaId, channelsCtx()),
      onReorderCommunities: (newOrder: typeof channels.channelWorkspaces) =>
        void channels.reorderWorkspaces(newOrder, channelsCtx()),
      // Absent before the session: the rail's hold menu is not offered over a preview (F1).
      onMarkCommunityRead: session.isLoggedIn
        ? (workspaceId: string) => void channels.markCommunityRead(workspaceId, channelsCtx())
        : undefined,
      onReorderChannels: (
        workspaceSlug: string,
        newOrder: (typeof channels.channelWorkspaces)[number]['channels']
      ) => void channels.reorderChannels(workspaceSlug, newOrder, channelsCtx()),
      onLeaveWorkspace: (workspaceDbId: string) => {
        void channels.leaveCurrentWorkspace(workspaceDbId, channelsCtx());
        if (isSelectedChannel) {
          const ws = channels.channelWorkspaces.find((w) => w.workspaceDbId === workspaceDbId);
          if (ws?.channels.some((c) => c.id === convs.selectedContact))
            convs.selectedContact = null;
        }
      },
      onDeleteWorkspace: (workspaceDbId: string, confirmationName: string) => {
        // Resolve the channel list before the delete purges the workspace from the sidebar.
        const doomedChannelIds =
          channels.channelWorkspaces
            .find((w) => w.workspaceDbId === workspaceDbId)
            ?.channels.map((c) => c.id) ?? [];
        void channels.deleteCurrentWorkspace(workspaceDbId, confirmationName, channelsCtx());
        if (convs.selectedContact && doomedChannelIds.includes(convs.selectedContact)) {
          convs.selectedContact = null;
        }
      },
      onSelectConversation: handleSelectConversation,
      onJoinPrivateChannel: (channelId: string, channelName: string) => {
        // Before the session there is nobody to join as: said, not attempted (F1 preview).
        if (!session.isLoggedIn) {
          log(`[WORKSPACE-SNAPSHOT] join of ${channelId.slice(0, 16)} pressed before the session`);
          showToast(m.communities_wait_for_session(), 'info');
          return;
        }
        // An admin entering a private salon they could only see. Awaited nowhere: the reload it
        // triggers is what re-renders the row, and the toast is what reports either outcome.
        void channels.joinPrivateChannelAsAdmin(channelId, channelName, channelsCtx());
      },
      onSelectChannelConversation: (channelId: string) => {
        if (landOnSalonOnceOpenable(channelId)) return;
        // THE PRESSED ROW LIGHTS UP FIRST, AND THE SALON MOUNTS AFTER THAT FRAME IS PAINTED. Both
        // used to happen in one flush, so the thread's mount - 382 ms for a 48-message salon on the
        // Mi 9T, ~1.6 s for a 50-face "general" on a Pixel 6a (store 1.2.6, 2026-10-13) - held the
        // list frozen with no sign the press had been taken. The row's highlight is
        // `selectedChannelId`; the thread follows `selectConversation`, below.
        channels.selectedChannelConversationId = channelId;
        // THE HISTORY REQUEST LEAVES ON THE PRESS, not after the pane is drawn: the pane's mount
        // used to sit in front of it (323 ms at 1x, 1.1 s at 4x on a Mi 9T, 2026-10-14), and nothing
        // the request needs is in the pane. It resolves into the conversation map, which the pane
        // reads when it mounts a frame later.
        void convs.loadHistoryForConversation(channelId, channelId, convCtx(), { atTap: true });
        afterNextPaint(() => {
          // A second press during the frame wins: the first salon is not mounted under it.
          if (channels.selectedChannelConversationId !== channelId) return;
          // THE RECEIPT IS OWED FOR WHAT WAS THERE TO READ, not for what this device had counted as
          // unread. Read BEFORE selectConversation, which resets the conversation's state; the
          // marker in `channelReadSignal` is what keeps an idle re-open from pushing to ourselves.
          const readUpTo = newestForeignMessageAt(
            convs.conversations.get(channelId)?.messages ?? [],
            session.userId
          );
          convs.selectConversation(channelId);
          if (claimChannelReadSignal(channelId, readUpTo)) {
            void channelService.markChannelRead(channelId);
          }
        });
      },
      onSelectCommunity: () => {
        // Switching community must not keep the previous channel open: clear the selection
        // so the chat area shows nothing until a channel of the new community is picked.
        channels.selectedChannelConversationId = '';
        convs.selectedContact = null;
      },
      // PULL-TO-REFRESH ON THE CONVERSATION LIST, and the one thing the gesture can honestly mean.
      //
      // It used to sleep 600 ms and return - no reconnect, no fetch, nothing - on the reasoning
      // that the visibility-change watchdog would get there eventually. So the spinner reported
      // work that was not happening, and it reported it for a fixed duration unrelated to anything.
      //
      // The list is fed by the WebSocket, so while the socket is up it is ALREADY current and a
      // refresh has no work at all; `canRefresh` below declines the gesture outright rather than
      // spin over nothing. While it is down the backoff ladder is armed but may be up to 30 s from
      // its next rung, and pulling is the user asking for that rung NOW. `attemptReconnect` is
      // exactly that request and is safe to make directly: it clears the armed timer rather than
      // orphaning it, no-ops if an attempt is already in flight or this tab is a follower, and
      // awaits the full post-connect sync - so the spinner lasts precisely as long as the work.
      onRefresh: async () => {
        await session.attemptReconnect(sessionCb());
      },
      canRefresh: () => session.isLoggedIn && !session.isWsConnected,
      previewOnly: !session.isLoggedIn,
      listRefreshing: communitiesRefreshing,
    };
  }

  /**
   * A salon row tapped while it cannot be opened yet - before the session, or drawn from the saved
   * snapshot before the listing gave it a conversation - becomes a LANDING (`notifNav`), the same
   * path a notification takes: the row lights up now, and `ChatBackgroundService` selects the salon
   * the moment the session is up and the salon is in the map. No clock: the landing re-runs on both
   * facts. Returns true when it took the tap.
   */
  function landOnSalonOnceOpenable(channelId: string): boolean {
    if (session.isLoggedIn && convs.conversations.has(channelId)) return false;
    log(
      `[WORKSPACE-SNAPSHOT] salon ${channelId.slice(0, 16)} tapped before it can open (session ${session.isLoggedIn ? 'up' : 'not up'}) - landing on it once it can`
    );
    channels.selectedChannelConversationId = channelId;
    notifNav.navigate(channelId);
    return true;
  }

  // ─── A salon message left unanswered by a PREVIOUS page life is sent again ──────────────────────
  // The echo is memory only and the composer was cleared at the click, so the unsent ledger is the
  // salon queue's durable half (WP-OFF-3): once the session is up, what a killed or reloaded page
  // life left there is sent again under its client id, which the server answers with the row it
  // holds if the first POST had landed. Only entries whose writer is PROVEN dead are taken - a
  // sibling tab still sending its own keeps them.
  $effect(() => {
    const userId = session.userId;
    if (!userId || !session.isLoggedIn) return;
    void untrack(async () => {
      const legacy = await messaging.resumeUnsentSends(msgCtx(), null);
      // Written before the ledger kept a payload's `sentAt`: put back, owned by this page life, for
      // the salon's own composer below.
      for (const o of legacy) recordUnsentSalonText(userId, o);
    });
  });

  // Opening a salon resumes what is still waiting for it: an entry kept because its conversation was
  // not drawn yet, or one a sibling tab left when it closed. An entry written before WP-OFF-3 has no
  // `sentAt`, cannot be rebuilt as composed, and goes back to the composer as it did before.
  $effect(() => {
    const contact = convs.selectedContact;
    const userId = session.userId;
    if (!contact || !userId || !isChannelConversationId(contact)) return;
    void untrack(async () => {
      const restore = messaging.lateDraftWriter(contact, 'resumed salon text');
      const orphans = await messaging.resumeUnsentSends(msgCtx(), contact);
      if (orphans.length > 0 && convs.selectedContact !== contact) {
        // The member left the salon while the owner check ran: the texts belong to ITS composer,
        // so they go back in the ledger, owned by this page life, for the next visit.
        log(`[SEND] ${orphans.length} restorable salon text(s) kept: the salon was left meanwhile`);
        for (const o of orphans) recordUnsentSalonText(userId, o);
        return;
      }
      for (const o of orphans) {
        restore(restoreFailedDraft(messaging.draftFor(contact), o.text));
        log(
          `[SEND] unanswered salon message ${o.messageId.slice(0, 8)}... of a past session restored to the composer`
        );
      }
    });
  });

  // ─── Load group members when selected conversation changes ────────────────
  $effect(() => {
    const contact = convs.selectedContact;
    if (!contact || !session.isLoggedIn) return;
    const convo = convs.conversations.get(contact);
    if (!convo?.id) return;
    void convs.loadGroupMembers(convo.id, convCtx());
  });

  // ─── Load channel members when selected channel changes ───────────────────
  $effect(() => {
    const contact = convs.selectedContact;
    if (!contact || !session.isLoggedIn || !isSelectedChannel) {
      selectedChannelMemberIds = [];
      return;
    }
    let cancelled = false;
    channelService
      .listMembers(contact)
      .then((members) => {
        if (cancelled) return;
        selectedChannelMemberIds = members.map((m) => m.userId);
      })
      .catch(() => {
        if (cancelled) return;
        selectedChannelMemberIds = [];
      });
    return () => {
      cancelled = true;
    };
  });

  // ─── Read watermark (debounced 2 s; delivered at once on leave or off-screen) ──
  /** The pending mark of the conversation being read (see `readMarkDebounce.ts`). */
  const readMarks = createReadMarkDebounce(2000);

  /** Delivers `userId`'s owed salon read marks; a refusal keeps it owed (`salonReadMarkQueue.ts`). */
  function flushOwedSalonMarks(userId: string): Promise<number> {
    return flushSalonReadMarks(userId, (id, at, serverAt) =>
      channelService.advanceReadMark(id, at, serverAt)
    );
  }

  $effect(() => {
    // LEAVING INSIDE THE WINDOW DELIVERS THE MARK, AND IT IS DETECTED HERE, FIRST, BEFORE ANY RETURN.
    // The left conversation's own callback runs: a DM's hands its mark to the outbox, a salon's
    // delivers the owed queue AND the banner signal for the account's other devices. This was the
    // effect's teardown until 2026-10-27, and a teardown reads `selectedContact` as it was BEFORE the
    // change, so the leave was never seen and the next conversation's note joined the old window.
    // `readMarkDebounce.leave.svelte.test.ts` pins that this call stays the effect's first statement.
    const selectedNow = convs.selectedContact;
    untrack(() => readMarks.follow(selectedNow));
    if (!convs.selectedContact || !session.isLoggedIn) return;
    // THE THIRD TERM IS THE ONLY ONE A PHONE ANSWERS HONESTLY. `hasFocus()` and `visibilityState`
    // are both permanently true in a backgrounded Tauri WebView (measured on device 2026-09-05:
    // a backgrounded app reports `visible` / `hasFocus: true`, byte for byte its foreground
    // answer), so on Android these two said "the user is reading this" about a phone in a pocket -
    // and the sender was told their message had been read. `isAppInForeground` reads the fact the
    // Android activity states for itself, and is `true` everywhere that has a working visibility
    // API, so the two terms above keep deciding web and desktop exactly as before.
    if (!isWindowFocused || !isTabVisible || !isAppInForeground()) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo || convo.lifecycle !== 'active') return;

    const meNorm = session.userId.toLowerCase();
    const held = watermarkFor(convo.readWatermarks, meNorm);
    // A DM or group mark moves over FOREIGN messages only: one moved over this reader's own send
    // told nobody anything and cost every member a decrypt and a checkpoint (`readMarkTarget`).
    const target = readMarkTarget(convo.messages, held, isSelectedChannel);
    if (target <= held) return;

    const currentContact = convs.selectedContact;
    // The account that READ, captured with the reading: the window can be delivered after a
    // sign-out or an account switch (`readMarks.follow(null)` delivers it at once), and its marks
    // belong to the ledger of the account that decided them.
    const reader = session.userId;

    // Mark it read here and now, on this device, for good: the optimistic update goes into the
    // conversation AND onto disk. It used to be a bare in-memory `conversations.set`, so a reload
    // brought back as unread everything this device had read but no peer had echoed (D2).
    untrack(() => {
      setTimeout(() => {
        const fresh = convs.conversations.get(currentContact);
        if (!fresh) return;
        // The count moves with the watermark (the open conversation is read, so it falls to 0),
        // and the OTHER TABS of this account are told: a leader tab that counted the arrival while
        // this tab had the conversation open would otherwise keep its `(N)` for good.
        const next = withOwnReadAdvanced(fresh, meNorm, target);
        if (next === fresh) return;
        convs.conversations.set(currentContact, next);
        publishConversationRead(currentContact, next.lastMessageAt ?? 0);
        void convs.saveConversation(currentContact, convCtx());
      }, 0);
    });

    // A SALON'S RECEIPT GOES TO THE SERVER, A DM'S OVER MLS - AND UNTIL 2026-09-29 A SALON HAD NONE.
    //
    // The MLS half genuinely cannot run here: a channel is server-authoritative and has no MLS
    // group, so `sendReadWatermark` -> `enqueueControlEvent` would leave the flusher looping on
    // resolveTerminalGroup / welcome-request 500s for a `channel_` conversation id. So this effect
    // returned here for a salon, and nothing replaced it: the server kept no read state at all, and
    // every sender in a community saw "Envoyé" for ever (reported by the user 2026-09-29). The
    // receipt now takes the same debounce, the same focus guard and the same instant, and only the
    // transport differs - `advanceReadMark`, which the server stores and fans out as `channel.read`.
    const channelReceipt = isSelectedChannel;

    // A SALON'S MARK IS WRITTEN DOWN BEFORE ANY NETWORK. The debounce below can be cut short (the
    // reader leaves, the page reloads) and the POST can fail (a deploy, a dead link); the owed mark
    // survives both and is delivered by the next flush. See `salonReadMarkQueue.ts`.
    if (channelReceipt) {
      let newestServerAt = 0;
      for (const msg of convo.messages) {
        // System rows included: the server counts a membership notice until a mark reaches it.
        if (msg.serverTimestamp !== undefined) {
          newestServerAt = Math.max(newestServerAt, msg.serverTimestamp);
        }
      }
      recordSalonReadMark(reader, currentContact, target, newestServerAt || undefined);
    } else {
      // A DM'S MARK IS OWED FROM HERE TOO, to the outbox: a process killed inside the debounce used to
      // take it along, after the local mark had moved, so nothing sent it again and the peer kept the
      // conversation unread for good. The next outbox registration drains it (`flushOwedDmReadMarks`).
      recordDmReadMark(reader, currentContact, target);
    }

    readMarks.note(
      target,
      (toSend) => {
        untrack(() => {
          if (channelReceipt) {
            // The mark was recorded durably when it was decided; this only delivers it.
            void flushOwedSalonMarks(reader);
            // THE BANNER SIGNAL FOLLOWS THE READING, NOT THE ARRIVAL. A message that landed while the
            // reader was elsewhere (another route, a hidden tab) is deliberately NOT announced as
            // read on arrival (`isReadingConversationNow`), so nothing has yet told this account's
            // other devices to drop its banner. The marker is shared with the arrival path: a message
            // already signalled is not signalled twice.
            // The newest FOREIGN message, not `toSend`: the watermark also advances over this user's
            // own sends, and signalling those would be a self-push after every message written.
            // Capped at `toSend`: a message that landed after the reading was decided (in the
            // flush of a leave) was never read and keeps its banner.
            const readUpTo = newestForeignMessageAt(
              convs.conversations.get(currentContact)?.messages ?? [],
              reader,
              toSend
            );
            if (claimChannelReadSignal(currentContact, readUpTo)) {
              void channelService.markChannelRead(currentContact);
            }
            return;
          }
          // The mark was recorded durably when it was decided; this hands every owed one to the
          // outbox, which is durable from there. One the outbox cannot take stays owed and is logged.
          // A conversation gone from the store whose mark is STILL owed lost its receipt by accident:
          // that is the drop worth a warning. One the user left or deleted had its mark forgotten on
          // purpose before it was retired (`retireConversation`'s caller, GRP-6), so it says nothing.
          if (
            !convs.conversations.get(currentContact) &&
            currentContact in owedDmReadMarks(reader)
          ) {
            console.warn(
              `[READ] watermark ${toSend} dropped: conversation ${currentContact} left the store` +
                ' between the debounce arming and its expiry, so the receipt is never sent'
            );
            forgetDmReadMark(reader, currentContact);
          }
          void flushOwedDmReadMarks(reader);
        });
      },
      currentContact
    );
    // Same-conversation re-runs (e.g. from the optimistic update above) must not end the pending
    // window - that was the root cause of receipts never firing - and `readMarks.follow` ends it
    // only when the selection names another conversation.
  });

  // ─── Refused control actions: the account's list, and the Retry that runs them ────
  // The notices are durable per account, so they are bound to whoever is signed in; a Retry runs
  // with the context of the tap (`msgCtx()` is built fresh), never one captured at the refusal.
  $effect(() => {
    if (session.userId) loadControlRefusals(session.userId);
  });
  onMount(() => {
    setControlRetryExecutor((refusal) => messaging.retryRefusedControl(refusal, msgCtx()));
    return () => setControlRetryExecutor(null);
  });
  // A member's answer to a new person asking to join (`JoinRequestRow`), run with the context of
  // the tap: admitting is this device's own Add, declining removes the roster row.
  onMount(() => {
    setJoinRequestHandlers({
      approve: (request) => convs.approveJoinRequest(request, convCtx()),
      decline: (request) => convs.declineJoinRequest(request, convCtx()),
    });
    return () => setJoinRequestHandlers(null);
  });

  // ─── Mount: event listeners (window focus, visibility, debug shortcut) ────
  onMount(() => {
    isWindowFocused = document.hasFocus();
    isTabVisible = document.visibilityState === 'visible';

    const handleVisibilityChange = () => {
      isTabVisible = document.visibilityState === 'visible';
    };
    const handleWindowFocus = () => {
      isWindowFocused = true;
    };
    const handleWindowBlur = () => {
      isWindowFocused = false;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Shift+S: force sync reset (clears device cache and reloads)
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        if (session.isLoggedIn && session.userId) {
          forceSyncReset(session.userId, log);
          log('[INFO] Reloading page in 1s…');
          setTimeout(() => window.location.reload(), 1000);
        }
      }
    };

    const handleKeyboardMediaEvent = (e: Event) => {
      handleKeyboardMedia((e as CustomEvent).detail ?? {});
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleWindowFocus);
    window.addEventListener('blur', handleWindowBlur);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('canari-keyboard-media', handleKeyboardMediaEvent);
    // The app leaving the screen ends the reading: the pending read mark is delivered now rather
    // than at a window expiry the OS may never let run (a backgrounded phone suspends timers).
    const offScreenChange = onAppScreenChange((onScreen) => {
      if (!onScreen) readMarks.flush();
    });
    return () => {
      offScreenChange();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleWindowFocus);
      window.removeEventListener('blur', handleWindowBlur);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('canari-keyboard-media', handleKeyboardMediaEvent);
    };
  });

  // ─── Apply pending conversation selection (from cross-page navigation) ────
  $effect(() => {
    if (!session.isLoggedIn) return;
    untrack(() => {
      const pending = sessionStorage.getItem('canari_pending_contact');
      if (pending) {
        sessionStorage.removeItem('canari_pending_contact');
        setTimeout(() => {
          convs.selectConversation(pending);
        }, 600);
      }
    });
  });

  // ─── Reset selection when switching between /chat and /communities ─────────
  // The selection lives in global singletons (globalConvs/globalChannels) that outlive this
  // component, and /chat and /communities are separate route components, so navigating between
  // them remounts MainChatPage. Comparing against the module-scoped lastActiveRouteMode (which
  // survives that remount) lets us clear the stale thread on a genuine tab switch while still
  // preserving a deep-linked selection on the very first mount.
  $effect.pre(() => {
    const mode = routeMode;
    untrack(() => {
      const previous = lastActiveRouteMode;
      lastActiveRouteMode = mode;
      if (previous === null || previous === mode) return;
      // A deep link navigated us here and its target is still landing: this is not a tab switch,
      // and wiping the selection (or the community the sidebar reveals) is what made those land on
      // an empty /communities. Entering the OTHER mode instead means the user walked away from the
      // landing, which ends it.
      const landing = notifNav.pending;
      if (landing) {
        if (selectionBelongsToRoute(landing, mode)) return;
        notifNav.clear();
      }
      // Same reasoning for a target already selected: a genuine tab switch never carries a
      // selection that belongs to the mode being entered.
      if (selectionBelongsToRoute(convs.selectedContact, mode)) return;
      // The reading ends here, so its pending mark is DELIVERED - it used to be zeroed, after the
      // local mark had moved, which lost the receipt for good.
      readMarks.flush();
      convs.selectedContact = null;
      channels.selectedChannelConversationId = '';
      convs.closeSidePanel();
      convs.sendError = '';
    });
  });

  /** Opens a discussion and loads/decrypts its history (same as channel selection). */
  function handleSelectConversation(name: string) {
    convs.selectConversation(name);
    const convo = convs.conversations.get(name);
    if (convo?.id) {
      void convs.loadHistoryForConversation(name, convo.id, convCtx());
    }
  }

  // ─── Thin forwarding helpers (keep template free of logic) ────────────────

  /**
   * Sends `text`, and makes sure a failure on the way cannot vanish.
   *
   * `void promise` DISCARDS A REJECTION, and this is the send path. `sendChatMessage` writes the
   * optimistic echo and then awaits `enqueueOutboxMessage` with no `catch` of its own, so an
   * IndexedDB transaction that aborts rejects all the way up to here - where the promise was thrown
   * away. The user then sees the composer empty (it is cleared synchronously below, without waiting
   * for the enqueue), a bubble stuck on `pending`, no error, and NOTHING in the log: a message they
   * wrote, believe sent, and that no durable queue ever received. That is the one failure the
   * outbox cannot survive, because it is the one it never hears about.
   *
   * The catch does not restore the text - the echo is already on screen and pulling it back would
   * be a second surprise. It says so, out loud, on both surfaces: the error banner the media path
   * already uses, and the log, because a best-effort path that swallows leaves nothing else behind.
   *
   * THE TWO SURFACES SAY DIFFERENT THINGS, AND THAT IS THE POINT. What reaches here is an
   * exception `handleSendChat` did not expect - an aborted IndexedDB transaction, a failure in the
   * MLS layer - so its message is dev prose in English, and there is no status anywhere on this
   * path to say anything sharper. The banner therefore carries the generic line, and the exception
   * goes to the log, where English is correct and where the cause is still recoverable.
   */
  function sendText(text: string, onRefused?: () => void) {
    whenSessionUp(`text (${text.length} chars)`, () => sendTextNow(text, onRefused));
  }

  /**
   * Sends made while the page shows a LOCAL PREVIEW (F1), held until the session is up - the queue
   * and why it exists are `heldSends.ts`. The page adds what a queue cannot know: the count is
   * SHOWN while anything waits (so nobody retypes it), and a held send that does not go - the login
   * ended without a session, the selection moved, the page was left - is said out loud on a toast
   * (which outlives this page and the redirect to /login) and in the log. Its text is not put back:
   * the conversation it was written in is no longer on screen.
   */
  const heldSends = createHeldSendQueue();
  let heldCount = $state(0);

  function whenSessionUp(what: string, run: () => void, discard?: () => void) {
    if (session.isLoggedIn) {
      run();
      return;
    }
    heldSends.hold({ what, target: convs.selectedContact, run, discard });
    heldCount = heldSends.size;
    log(`[LANDING_PREVIEW] ${what} held until the session is up`);
  }

  /** Reports held sends that will never go: toast for the member, log line for the reader. */
  function reportUnsent(dropped: { what: string }[], why: string, notice: string) {
    if (dropped.length === 0) return;
    showToast(notice, 'error', 8000);
    log(
      `[LANDING_PREVIEW] ${dropped.length} held send(s) NOT sent (${why}): ` +
        dropped.map((h) => h.what).join(', ')
    );
  }

  $effect(() => {
    const up = session.isLoggedIn;
    const previewing = isLocalPreview;
    if (heldCount === 0) return;
    untrack(() => {
      if (up) {
        const { sent, misdirected } = heldSends.release(convs.selectedContact);
        heldCount = 0;
        log(`[LANDING_PREVIEW] session up - sending ${sent.length} held send(s)`);
        reportUnsent(
          misdirected,
          'the conversation changed before the session came up',
          m.chat_send_held_misdirected({ count: misdirected.length })
        );
        return;
      }
      if (previewing) return;
      const dropped = heldSends.drop();
      heldCount = 0;
      // A second notification replaced the landing: the sign-in did not fail, the conversation
      // changed - which is what the member must be told, not "the sign-in did not complete".
      const pending = notifNav.pending;
      const replaced = pending !== null && dropped.some((h) => h.target !== pending);
      reportUnsent(
        dropped,
        replaced
          ? `another landing (${pending.slice(0, 8)}) replaced the preview before the session came up`
          : 'the preview was withdrawn before the session came up',
        replaced
          ? m.chat_send_held_misdirected({ count: dropped.length })
          : m.chat_send_held_not_sent({ count: dropped.length })
      );
    });
  });

  // LEAVING THE PAGE DURING A PREVIEW ENDS THE LANDING. What is held cannot be sent from a page
  // that is gone, and the preview row would stay in the map with nothing on screen to show it -
  // so both are ended here, explicitly: the held sends are reported, the preview is discarded and
  // the landing is cleared (abandoned, in `notifNav`'s terms). Only when the preview is the
  // SELECTION, which `previewSelect` sets on the landing's own page: the `/communities` page,
  // unmounting while the landing routes to `/chat`, has not drawn it and must not end it.
  onDestroy(() => {
    const dropped = heldSends.drop();
    reportUnsent(
      dropped,
      'the chat page was left before the session came up',
      m.chat_send_held_not_sent({ count: dropped.length })
    );
    if (session.isLoggedIn) return;
    const key = convs.landingPreviewKey;
    if (key === null || convs.selectedContact !== key) return;
    convs.discardLandingPreview(
      'the chat page was left before the session came up',
      messaging.messageReactions,
      log
    );
    if (notifNav.pending === key) notifNav.clear();
  });

  function sendTextNow(text: string, onRefused?: () => void) {
    void messaging
      .handleSendChat(msgCtx(), text)
      .then((delivered) => {
        if (delivered === false) onRefused?.();
      })
      .catch((e: unknown) => {
        convs.sendError = m.chat_send_error_generic();
        log(`[SEND] handleSendChat threw - the message was NOT queued: ${String(e)}`);
      });
  }

  /**
   * Sends the open conversation's draft, then clears it - and GIVES THE TEXT BACK if the send was
   * refused with no bubble and no queue entry (a community salon, offline: WP-OFF-1). The text goes
   * back to the draft of the conversation it was written in, whichever one is open by then; the
   * error banner stays.
   */
  function handleSendChat() {
    const contact = convs.selectedContact;
    const text = messaging.draftFor(contact);
    const restore = messaging.lateDraftWriter(contact, 'refused send');
    sendText(text, () => {
      restore(restoreFailedDraft(messaging.draftFor(contact), text));
      log(`[SEND] refused: draft restored to its conversation (${text.length} chars)`);
    });
    messaging.setDraft(contact, '');
  }

  /** Forwards selected files to the messaging composable for upload. */
  function handleFilesSelected(files: File[]) {
    whenSessionUp(`${files.length} file(s)`, () => {
      void messaging.handleFilesSelected(files, msgCtx());
    });
  }

  /**
   * Sends a finished recording immediately - it never joins the pending queue.
   *
   * Same treatment as {@link sendText} for the rejection: this is a send path, and `void` on a
   * promise throws the failure away. The recording is gone from the recorder by the time this
   * runs, so a silent rejection would be a voice note the user watched themselves record and that
   * nothing ever received.
   */
  function handleSendVoiceNote(file: File) {
    whenSessionUp('a voice note', () => {
      void messaging.sendVoiceNote(file, msgCtx()).catch((e: unknown) => {
        convs.sendError = m.chat_send_error_generic();
        log(`[SEND] sendVoiceNote threw - the recording was NOT queued: ${String(e)}`);
      });
    });
  }

  /**
   * Handles rich content committed by the soft keyboard (e.g. a Gboard GIF), delivered by
   * the native KeyboardMediaBridge (Android `InputConnection.commitContent`, iOS `UIPasteboard`
   * polling) as a `canari-keyboard-media` event. Rebuilds a File from the base64 payload and
   * routes it through the normal media pipeline (encrypted upload), so a keyboard GIF behaves
   * exactly like a picked file - in DMs, groups, and channels alike.
   */
  function handleKeyboardMedia(detail: { mime?: string; name?: string; data?: string }) {
    if (!convs.selectedContact || !detail?.data) return;
    try {
      const bin = atob(detail.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const mime = detail.mime || 'image/gif';
      const name = detail.name || `gif-${Date.now()}.${mime.split('/')[1] ?? 'gif'}`;
      handleFilesSelected([new File([bytes], name, { type: mime })]);
    } catch (e) {
      appendLog(`[keyboard-media] failed to handle committed content - ${e}`);
    }
  }

  // ─── A share from another app lands in the composer of the conversation it was sent to ────────
  // `IncomingShareHost` asked where it goes and landed on that conversation; once it is the one on
  // screen, its text joins the draft and its files are read from disk into the pending queue -
  // through the same preparation as a picked file (size ceiling, compression, video re-encode). The member sends it with Send:
  // a share is never sent on its own.
  $effect(() => {
    const target = incomingShare.target;
    const selected = convs.selectedContact;
    if (!target || !selected) return;
    if (resolveConversationKey(convs.conversations, target) !== selected) return;
    untrack(() => {
      const share = incomingShare.takeFor(target);
      if (!share) return;
      log(
        `[SHARE] staged in ${selected.slice(0, 16)}: ${share.text.length} chars, ${share.files.length} file(s)`
      );
      if (share.text) {
        messaging.setDraft(selected, restoreFailedDraft(messaging.draftFor(selected), share.text));
      }
      if (share.files.length === 0) return;
      // The copies are read HERE, once a destination is on screen, and not when the share arrived -
      // one at a time, each staged before the next is read, under the composer's own ceiling.
      const files = share.files;
      const destination = selected;
      // THE SESSION THE SHARE WAS TAKEN IN, read NOW - not after a held send or a network round
      // trip, either of which a sign-out can fall inside (`stageSharedFiles`, `stillWanted`).
      const generation = signOutGeneration();
      whenSessionUp(
        `a share of ${files.length} file(s)`,
        () => void stageShare(files, destination, generation),
        // Held, then never run: its copies are this share's to delete.
        () =>
          void discardSharedFiles(
            files.map((f) => f.path),
            'held share not sent'
          )
      );
    });
  });

  /**
   * Stages a share's files in the open conversation, one at a time, and says what did not make it:
   * a copy over the upload ceiling (deleted unread, told as the composer tells a picked one) and a
   * copy that could not be read. Every file goes to `destination`, the conversation the share was
   * taken by, whichever one is on screen when its turn comes (`stageSharedFiles`).
   */
  async function stageShare(files: SharedFileEntry[], destination: string, generation: number) {
    const limits = await new MediaService().uploadLimits();
    // A sign-out since the share was taken stops the staging - before each file is read, and again
    // after each is prepared - so nothing of it reaches the next account's composer.
    const stillWanted = () => signOutGeneration() === generation;
    const { lost, tooLarge } = await stageSharedFiles(
      files,
      destination,
      limits,
      (file, to) =>
        messaging.handleFilesSelected(
          [file],
          { ...msgCtx(), selectedContact: to },
          { stillWanted }
        ),
      stillWanted
    );
    // Signed out meanwhile: nobody is here to be told, and the next account must not be.
    if (!stillWanted()) return;
    if (lost > 0) showToast(m.share_items_lost({ count: lost }), 'error');
    if (tooLarge.length > 0 && limits) {
      showToast(
        m.chat_media_too_large({
          size: (tooLarge[0].size / 1024 / 1024).toFixed(1),
          limit: Math.round(limits.maxBytes / 1024 / 1024),
        }),
        'error'
      );
      log(`[SHARE] ${tooLarge.length} shared file(s) over the upload ceiling, deleted unread`);
    }
  }

  /** Opens the forward picker for a given message. */
  function handleForward(message: ChatMessage) {
    forwardingMessage = message;
  }

  /**
   * Forwards the pending message to the conversation chosen in the modal. `targetLabel` comes from
   * the picker rather than `conversation.name`, which for a DM is the peer's raw user id and would
   * put a 64-char hash in the confirmation toast.
   */
  async function doForward(targetKey: string, _target: Conversation, targetLabel: string) {
    const message = forwardingMessage;
    forwardingMessage = null;
    if (!message) return;
    const result = await messaging.forwardMessage(message.content, targetKey, msgCtx());
    if (result.success) {
      showToast(m.chat_message_forwarded({ name: targetLabel }), 'info');
    } else {
      showToast(result.error ?? m.chat_forward_error_fallback(), 'error');
    }
  }

  /**
   * Routes a throttled typing signal to the right transport for the active
   * conversation: gateway WS for DMs/groups (keyed by the MLS groupId), social
   * HTTP for community channels. Best-effort - failures are ignored.
   */
  function handleTyping(isTyping: boolean) {
    const key = convs.selectedContact;
    if (!key) return;
    // A typing signal is a frame on the session's socket; a local preview has neither (F1).
    if (!session.isLoggedIn) return;
    if (isSelectedChannel) {
      void channelService.sendTyping(key, isTyping);
      return;
    }
    const convo = convs.conversations.get(key);
    if (!convo?.id) return;
    Promise.resolve(session.ensureMls())
      .then(async (m) => {
        await m?.sendTyping?.(convo.id, isTyping);
        dmTypingFailing = false;
      })
      .catch((e) => {
        // One line per failing streak, not per keystroke; the next success re-arms it.
        if (dmTypingFailing) return;
        dmTypingFailing = true;
        appendLog(`[typing] DM typing signal not delivered (further failures not logged) - ${e}`);
      });
  }
  let dmTypingFailing = false;

  /**
   * Loads the conversation's shared media/links/files from the FULL local history
   * (IndexedDB/SQLite), for the "Médias, liens & fichiers" panel.
   */
  async function loadSharedContent(conversationId: string): Promise<SharedContent> {
    // Community channels don't persist messages locally (skipDbSave), so aggregate from
    // the in-memory loaded messages. DMs/groups use the full local history from storage.
    if (isChannelConversationId(conversationId)) {
      const convo = convs.conversations.get(conversationId);
      const msgs = (convo?.messages ?? []).map((m) => ({
        id: m.id,
        senderId: m.senderId,
        timestamp: m.timestamp.getTime(),
        content: m.content,
        isDeleted: m.isDeleted,
      }));
      return aggregateSharedContent(msgs);
    }
    if (!session.storage) return { media: [], files: [], links: [] };
    const msgs = await session.storage.getMessages(conversationId, session.deviceKeyB64);
    return aggregateSharedContent(msgs);
  }

  /**
   * Full-conversation search returning matching message IDs oldest-first: over the local store for
   * DMs/groups, and over the full decrypted server history for channels (which are not persisted
   * locally). Returns null only when no source is available, so the UI falls back to the in-memory
   * loaded messages.
   */
  async function searchConversation(
    conversationId: string,
    query: string
  ): Promise<string[] | null> {
    const q = foldForSearch(query.trim());
    if (q.length < 2) return [];
    // Channels are not persisted locally: search their full server history (decrypt + match),
    // which also merges older hits into the view so the UI can scroll to them.
    if (isChannelConversationId(conversationId)) {
      return convs.searchChannelHistory(conversationId, query, convCtx());
    }
    if (!session.storage) return null;
    const msgs = await session.storage.getMessages(conversationId, session.deviceKeyB64);
    return msgs
      .filter((m) => !m.isDeleted && foldForSearch(messageSearchText(m.content)).includes(q))
      .map((m) => m.id);
  }

  function messageSearchText(content: string): string {
    try {
      return getPreviewText(parseEnvelope(content));
    } catch {
      return content;
    }
  }

  /**
   * Toggles a message's pinned state, routing to the right transport: server pin for community
   * channels, MLS `pin`/`unpin` system message for DMs/groups.
   *
   * A SALON PIN IS OPTIMISTIC AND OWED WHILE OFFLINE (WP-OFF-4): applied at once, sent on the
   * reconnect when the link is down (`deliverSalonWrite`; a later toggle owes the later state, and a
   * repeat SETS the same state), and reverted only when nothing of it reached the server
   * (`nothingLeftTheDevice`) - a 5xx may have stored it, and the pin list is re-read on every open.
   */
  function handleTogglePinMessage(messageId: string) {
    const key = convs.selectedContact;
    if (!key) return;
    const convo = convs.conversations.get(key);
    if (!convo) return;
    // THE SAME RULE THE MENUS WERE BUILT FROM, so a pin no menu offers is not sent from here either.
    if (!mayPinMessage({ inChannel: isSelectedChannel, canModerate: canModerateSelectedChannel })) {
      log(`[PIN] not sent: ${messageId.slice(0, 8)} - the viewer may not moderate this salon`);
      return;
    }
    if (isSelectedChannel) {
      const next = !isMessagePinned(convo.id, messageId);
      const at = Date.now();
      applyPin(convo.id, messageId, next, at);
      void deliverSalonWrite(
        `pin:${messageId}`,
        () => channelService.setMessagePinned(convo.id, messageId, next),
        (outcome) => {
          if (outcome.kind === 'owed') {
            log(`[PIN] pinned=${next} of ${messageId.slice(0, 8)} kept, sent on reconnect`);
            return;
          }
          if (outcome.kind === 'sent') return;
          const e = outcome.error;
          // Reverted STRICTLY LATER than the optimistic apply, or a refusal landing in the same
          // millisecond would tie with it - and a tie keeps a pin, so a refused unpin would never
          // come back.
          const revert = nothingLeftTheDevice(e);
          if (revert) applyPin(convo.id, messageId, !next, Math.max(Date.now(), at + 1));
          const status = refusalStatus(e);
          log(
            `[PIN] refused (status=${status ?? 'none'}) pinned=${next}, ${revert ? 'reverted' : 'kept (the server may hold it)'}: ${String(e)}`
          );
          showToast(
            describeApiRefusal(status, m.channel_action_pin()) ?? m.channel_pin_error(),
            'warning'
          );
        }
      );
    } else {
      void messaging.handleTogglePin(messageId, msgCtx());
    }
  }

  // Load the channel's pinned-message set from the server when a channel is opened.
  $effect(() => {
    const key = convs.selectedContact;
    if (!key || !isSelectedChannel) return;
    void channelService
      .listPinnedMessageIds(key)
      .then((ids) => setPinnedSet(key, ids))
      .catch(() => {});
  });

  /** Sends a picked GIF as a message (its direct URL is rendered inline as a GIF). */
  function handleSendGif(url: string) {
    sendText(url);
  }

  /** Encrypts and sends a community poll in the currently selected channel. */
  async function handleCreatePoll(draft: ChannelPollDraft) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    await sendChannelPoll(channelId, draft);
  }

  /**
   * Casts (or retracts) the user's vote on a channel poll, optimistically then authoritatively.
   *
   * OWED WHILE OFFLINE (WP-OFF-4): the choice stays on the card and is sent on the reconnect
   * (`deliverSalonWrite`; a later choice owes itself instead, and a vote SETS the selection, so a
   * repeat is harmless). Taken back only when nothing of it reached the server
   * (`nothingLeftTheDevice`), and only while the card still shows this choice.
   */
  async function handleVotePoll(messageId: string, optionIds: string[]) {
    const channelId = convs.selectedContact;
    const userId = session.userId;
    if (!channelId) return;
    const before = getPollMeta(messageId)?.votesByUser[userId] ?? [];
    applyLocalVote(messageId, userId, optionIds);
    await deliverSalonWrite(
      `vote:${messageId}`,
      async () => {
        const meta = await channelService.votePoll(channelId, messageId, optionIds);
        setPollMeta(messageId, meta);
      },
      (outcome) => {
        if (outcome.kind === 'owed') {
          log(`[POLL] vote on ${messageId.slice(0, 8)} kept, sent on reconnect`);
          return;
        }
        if (outcome.kind === 'sent') return;
        const e = outcome.error;
        const shown = getPollMeta(messageId)?.votesByUser[userId] ?? [];
        const revert =
          nothingLeftTheDevice(e) && JSON.stringify(shown) === JSON.stringify(optionIds);
        if (revert) applyLocalVote(messageId, userId, before);
        // `channelService` throws an `ApiRefusalError` whose `message` is the server's
        // own body: dev-facing English, correct for a log and wrong on a toast. The STATUS is what
        // picks the sentence, through the one refusal mapper - which answers `null` for a status it
        // has nothing better to say about, leaving the poll's own line to stand.
        const status = refusalStatus(e);
        log(
          `[POLL] vote refused (status=${status ?? 'none'}), ${revert ? 'taken back' : 'left as shown'}: ${String(e)}`
        );
        showToast(
          describeApiRefusal(status, m.channel_action_poll_vote()) ?? m.channel_poll_vote_error(),
          'warning'
        );
      }
    );
  }

  /**
   * Closes a channel poll now (server forces the deadline and unpins it). Offered to the poll's
   * author and to a salon moderator - the same pair the server's `closePoll` accepts.
   */
  async function handleClosePoll(messageId: string) {
    const channelId = convs.selectedContact;
    if (!channelId) return;
    log(`[POLL] closing ${messageId.slice(0, 8)} in ${channelId.slice(0, 8)}`);
    try {
      const meta = await channelService.closePoll(channelId, messageId);
      setPollMeta(messageId, meta);
    } catch (e) {
      // Same shape as the vote above, and the same reason.
      const status = refusalStatus(e);
      log(`[POLL] close refused (status=${status ?? 'none'}): ${String(e)}`);
      showToast(
        describeApiRefusal(status, m.channel_action_poll_close()) ?? m.channel_poll_close_error(),
        'warning'
      );
    }
  }

  /** Opens the community behind an invitation card ("Rejoindre la communauté"). */
  function handleJoinChannel(channelId: string) {
    void openInvitedChannel(channelId);
  }

  /**
   * Whether the conversation on screen is a one-to-one DM. A call is peer to peer since the
   * 2026-10-17 revival, and the signalling room seats exactly two users: a group has no call
   * button until a group design exists (calls-revival-plan WP-C4/WP-C11).
   */
  let selectedIsDirect = $derived(
    !!convs.selectedContact &&
      convs.conversations.get(convs.selectedContact)?.conversationType === 'direct'
  );

  /** Starts a voice or video call in the one-to-one conversation on screen. */
  function startCallForCurrentConversation(video: boolean) {
    if (!session.callService || !convs.selectedContact) return;
    const convo = convs.conversations.get(convs.selectedContact);
    if (!convo) return;
    if (convo.conversationType !== 'direct') return;
    if (convo.lifecycle !== 'active') {
      showToast(m.chat_call_session_not_ready(), 'warning');
      return;
    }
    session.callService.startCall(convo.id, video).catch((e: unknown) => {
      // It used to choose between these two toasts with
      // `msg.includes('Groupe introuvable') || msg.includes('Group not found')` - a distinction
      // carried in prose, and one that had already rotted: NOTHING in this client throws either
      // sentence. `describeCallFailure` reads the status `CallInitiateError` now carries.
      log(`[CALL] startCall failed: ${String(e)}`);
      showToast(describeCallFailure(e), 'warning');
    });
  }
</script>

<!--
  WHICH PAGE IS MOUNTED, published rather than inferred from the URL. `location.pathname` changes
  when SvelteKit STARTS a navigation and this component swaps after it, so for a moment the address
  says `/communities` while the `/chat` document is still on screen - and both pages render a
  sidebar with the same rows, so nothing in the DOM told the two apart. An instrument that read the
  URL and then clicked found the element it wanted on the page it was leaving, clicked into the
  swap, and reported `no stable element` about a screen where the thing was plainly there
  (`openChannel`, 2026-09-05). Same one-attribute cost as `data-conversation-tile`, same reason.
-->
<div class="app-layout" data-route-mode={routeMode} in:fade>
  {#if session.isLoggedIn || isLocalPreview || isWorkspacePreview}
    <!-- NO BANNERS HERE ANY MORE, and the two that were are why this comment exists. Both said what
         another banner was already saying: "En attente de connexion" duplicated `OfflineBanner` at
         the window scale (offline raised BOTH, three seconds apart), and the synchronisation strip
         duplicated `ChatArea`'s, driven by the very same `isCatchupOverlayVisible` - so they never
         appeared apart. Worse, both sat IN THE FLOW: raising one shoved the whole application down
         29 px and dropping it snapped everything back, which on 2026-08-14 delivered a click aimed
         at a channel row to the button below it. One fact, one banner, at one scale. -->
    <main class="main-content">
      <!-- Desktop sidebar (always mounted, hidden on mobile when chat is open) -->
      <!-- Not during a local preview: the list is the session's, and its rows act when tapped. The
           community list before the session is the exception (F1): it is this account's own
           snapshot, and its rows land through `notifNav` instead of acting (`previewOnly`). -->
      {#if session.isLoggedIn || isWorkspacePreview}
        <Sidebar {...makeSidebarCommonProps()} isHidden={convs.mobileView === 'chat'} />
      {/if}

      <svelte:boundary onerror={(e) => appendLog(`[UI] ChatArea error recovered: ${e}`)}>
        {#snippet failed(_error, reset)}
          <div
            class="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center"
          >
            <p class="text-text-muted text-sm">{m.chat_area_error_message()}</p>
            <button
              type="button"
              onclick={reset}
              class="text-cn-ink rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold"
            >
              {m.common_retry_button()}
            </button>
          </div>
        {/snippet}
        <ChatArea
          currentUserId={session.userId}
          conversation={activeConversation}
          localPreview={isLocalPreview}
          heldNotice={heldCount > 0 ? m.chat_send_held({ count: heldCount }) : ''}
          {messageText}
          isChannel={isSelectedChannel ?? false}
          imageMediaId={activeConversation?.imageMediaId ?? null}
          onMessageChange={(value) => messaging.setDraft(convs.selectedContact, value)}
          bindDraftWriter={() =>
            messaging.lateDraftWriter(convs.selectedContact, 'draft an edit replaced')}
          onSend={handleSendChat}
          onTyping={handleTyping}
          onSendGif={handleSendGif}
          onCreatePoll={isSelectedChannel ? handleCreatePoll : undefined}
          onVotePoll={isSelectedChannel ? handleVotePoll : undefined}
          onClosePoll={isSelectedChannel ? handleClosePoll : undefined}
          onOpenMedia={() => convs.toggleSidePanel('media')}
          onSearchAll={searchConversation}
          onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
          onBack={convs.goBackToMenu}
          onOpenConversations={convs.openConversationDrawer}
          onOpenSettings={() =>
            convs.toggleSidePanel(isSelectedChannel ? 'settings' : 'conversation')}
          isHidden={convs.mobileView === 'list'}
          onJoinChannel={handleJoinChannel}
          isLoadingHistory={convs.isLoadingHistory}
          isCatchingUpMessages={messaging.isMessageCatchupActive}
          isCatchupAnnounced={messaging.isCatchupOverlayVisible}
          groupMembers={convs.groupMembers}
          pendingInvites={convs.pendingGroupInvites}
          allowedUserIds={composerAllowedUserIds}
          canWrite={canWriteToSelectedChannel}
          sendError={convs.sendError}
          onGroupRename={(name) => void convs.handleRenameGroup(name, convCtx())}
          onGroupSetImage={(mediaId) => void convs.handleSetGroupImage(mediaId, convCtx())}
          onGroupDelete={() => void convs.handleDeleteGroup(convCtx())}
          onGroupDeleteLocally={() => void convs.handleDeleteGroupLocally(convCtx())}
          onGroupLeave={() => void convs.handleLeaveGroup(convCtx())}
          onGroupRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
          messageReactions={isSelectedChannel ? channelReactions : messaging.messageReactions}
          replyingTo={messaging.replyFor(convs.selectedContact)}
          onReply={(message) => messaging.handleReply(convs.selectedContact ?? '', message)}
          onForward={handleForward}
          onReact={isSelectedChannel
            ? (msgId, emoji) =>
                void channels.toggleChannelReaction(
                  convs.selectedContact ?? '',
                  msgId,
                  emoji,
                  channelsCtx()
                )
            : (msgId, emoji) => void messaging.handleAddReaction(msgId, emoji, msgCtx())}
          canModerate={canModerateSelectedChannel}
          onRetrySend={(msgId) => void messaging.retrySend(msgCtx(), msgId)}
          onDiscardSend={(msgId) => messaging.discardSend(msgCtx(), msgId)}
          onTakeBackSend={(msgId) => {
            const text = messaging.takeBackSend(msgCtx(), msgId);
            if (text !== null) {
              const contact = convs.selectedContact;
              messaging.setDraft(contact, restoreFailedDraft(messaging.draftFor(contact), text));
            }
          }}
          onDelete={isSelectedChannel
            ? (msgId) =>
                void channels.deleteChannelMessage(
                  convs.selectedContact ?? '',
                  msgId,
                  channelsCtx()
                )
            : (msgId) => void messaging.handleDeleteMessage(msgId, msgCtx())}
          onEdit={isSelectedChannel
            ? (msgId, text) =>
                void channels.editChannelMessage(
                  convs.selectedContact ?? '',
                  msgId,
                  text,
                  channelsCtx()
                )
            : (msgId, text) => void messaging.handleEditMessage(msgId, text, msgCtx())}
          onTogglePin={handleTogglePinMessage}
          onCancelReply={() => messaging.cancelReply(convs.selectedContact ?? '')}
          authToken={session.authToken}
          onFilesSelected={handleFilesSelected}
          onSendVoiceNote={handleSendVoiceNote}
          pendingFiles={messaging.pendingMediaFilesFor(convs.selectedContact)}
          onRemovePendingFile={(index) =>
            messaging.removePendingMediaFile(convs.selectedContact, index)}
          videoPreparation={messaging.videoPreparation}
          isUploading={messaging.isUploadingMedia}
          onStartAudioCall={callsAvailable(serverCallsMode()) && selectedIsDirect
            ? () => {
                void startCallForCurrentConversation(false);
              }
            : undefined}
          onStartVideoCall={callVideoAvailable(serverCallsMode()) && selectedIsDirect
            ? () => {
                void startCallForCurrentConversation(true);
              }
            : undefined}
          onOpenMembers={routeMode === 'communities' && isSelectedChannel
            ? () => convs.toggleSidePanel('members')
            : undefined}
          membersActive={convs.sidePanel === 'members'}
          onLoadOlderMessages={() => convs.loadOlderMessages(convs.selectedContact!, convCtx())}
          onRequestOlderFromPeers={() =>
            convs.requestOlderFromPeers(convs.selectedContact!, convCtx())}
          onMessagesScrollEl={(el) => {
            convs.chatContainer = el ?? undefined;
          }}
        />
      </svelte:boundary>

      <!--
        ONE PANEL, MOUNTED ONCE, BESIDE THE THREAD. Members, media and channel settings all render
        here; `convs.sidePanel` decides which, and a single value cannot hold two of them open.
        The members panel used to be mounted TWICE from this file - an inline column and a
        hand-rolled fixed drawer with its own scrim - which is where the divergence started.
      -->
      <ConversationSidePanel
        open={sidePanelKind !== null}
        title={sidePanelTitle}
        onClose={convs.closeSidePanel}
      >
        {#if sidePanelKind === 'members' && channels.selectedChannelConversationId}
          <ChannelMembersList
            currentUserId={session.userId}
            selectedChannelId={channels.selectedChannelConversationId}
          />
        {:else if sidePanelKind === 'media' && selectedConversationId}
          <ConversationMediaPanel
            conversationId={selectedConversationId}
            authToken={session.authToken}
            {loadSharedContent}
          />
        {:else if sidePanelKind === 'conversation'}
          <ChatGroupPanel
            effectiveDisplayName={activeView?.displayName ?? ''}
            contactName={activeView?.contactName ?? ''}
            groupId={activeConversation?.id ?? ''}
            isGroupConversation={activeView?.isGroup ?? false}
            imageMediaId={activeConversation?.imageMediaId ?? null}
            currentUserId={session.userId ?? ''}
            groupMembers={convs.groupMembers}
            pendingInvites={convs.pendingGroupInvites}
            onClose={convs.closeSidePanel}
            onRename={(name) => void convs.handleRenameGroup(name, convCtx())}
            onSetImage={(mediaId) => void convs.handleSetGroupImage(mediaId, convCtx())}
            onRemoveMember={(memberId) => void convs.handleRemoveMember(memberId, convCtx())}
            onGroupDelete={() => void convs.handleDeleteGroup(convCtx())}
            onGroupLeave={() => void convs.handleLeaveGroup(convCtx())}
            onInviteMembers={(ids) => void convs.inviteMembersToCurrentGroup(ids, convCtx())}
          />
        {:else if sidePanelKind === 'settings'}
          <ChannelSettingsPanel
            selectedChannelId={channels.selectedChannelConversationId}
            channelWorkspaces={channels.channelWorkspaces}
            onClose={convs.closeSidePanel}
            onRenameChannel={(channelId, newName) =>
              channels.renameCurrentChannel(channelId, newName, channelsCtx())}
            onDeleteChannel={(channelId) => {
              void channels.deleteCurrentChannel(channelId, channelsCtx());
              if (convs.selectedContact === channelId) convs.selectedContact = null;
            }}
            onLeaveChannel={(channelId) => {
              void channels.leaveCurrentChannel(channelId, channelsCtx());
              if (convs.selectedContact === channelId) convs.selectedContact = null;
            }}
          />
        {/if}
      </ConversationSidePanel>

      <!-- Mobile drawer sidebar (mounted only when the drawer is open) -->
      {#if convs.isConversationDrawerOpen}
        <Sidebar
          {...makeSidebarCommonProps()}
          isHidden={false}
          drawerMode={true}
          onCloseDrawer={convs.closeConversationDrawer}
        />
      {/if}

      <ForwardMessageModal
        open={!!forwardingMessage}
        conversations={[...convs.conversations.entries()]}
        excludeKey={convs.selectedContact}
        currentUserId={session.userId}
        channelWorkspaces={channels.channelWorkspaces}
        onClose={() => (forwardingMessage = null)}
        onSelect={doForward}
      />
    </main>
  {:else}
    <main class="main-content" aria-hidden="true"></main>
  {/if}

  {#if isMessagingBlocked}
    <MessagingSyncOverlay message={messagingOverlayMessage} />
  {/if}
</div>

<style>
  .app-layout {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
    width: 100%;
  }

  .main-content {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    position: relative;
  }
</style>
