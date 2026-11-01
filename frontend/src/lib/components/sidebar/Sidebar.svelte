<script lang="ts">
  import { coversScreen } from '$lib/actions/coversScreen.svelte';
  import EmojiText from '$lib/components/shared/EmojiText.svelte';
  import { previewContentOf } from '$lib/utils/chat/listPreview';
  import { untrack } from 'svelte';
  import { bindHistoryOverlay } from '$lib/utils/bindHistoryOverlay.svelte';
  import { flip } from 'svelte/animate';
  import { SvelteMap } from 'svelte/reactivity';
  import { dndzone, TRIGGERS, type DndEvent } from 'svelte-dnd-action';
  import { keepRowActivationKeys } from '$lib/utils/dndActivationKeys';
  import { longPress } from '$lib/actions/longPress';
  import CommunityRailMenu from './CommunityRailMenu.svelte';
  import { Hash, LoaderCircle, Lock, MessageSquarePlus, Plus, Settings, X } from '@lucide/svelte';
  import { showToast } from '$lib/stores/toast.svelte';
  import GroupAvatar from '../shared/GroupAvatar.svelte';
  import ConversationTile from '../chat/ConversationTile.svelte';
  import SidebarHeaderControls from './SidebarHeaderControls.svelte';

  import SidebarNewChatModal from './SidebarNewChatModal.svelte';
  import SidebarNewChannelModal from './SidebarNewChannelModal.svelte';
  import SidebarNewCommunityModal from './SidebarNewCommunityModal.svelte';
  import SidebarCommunityAdminPanel from './SidebarCommunityAdminPanel.svelte';
  import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
  import {
    isHiddenFromList,
    loadHiddenUnopenable,
    releaseHiddenOnceActive,
  } from '$lib/utils/chat/noHolder.svelte';
  import { isNeverAdmitted } from '$lib/utils/chat/admissionState';
  import type { ConversationOutcome } from '$lib/utils/chat/groupCreation';
  import { conversationRefusalMessage } from '$lib/utils/chat/conversationRefusalMessage';
  import {
    compareConversationRecency,
    conversationMatchesQuery,
    conversationRecency,
    recentDirectPeers,
    resolveConversationListPresentation,
  } from '$lib/utils/chat/conversations';
  import { pullToRefresh } from '$lib/actions/pullToRefresh';
  import type { Conversation } from '$lib/types';
  import { channelUnreadCount, communityHasUnread } from '$lib/utils/unreadTotal';
  import { m } from '$lib/paraglide/messages';
  import { moveById } from '$lib/utils/chat/channelOrder';
  import { createChannelPressTracker } from '$lib/utils/chat/channelPressGesture';
  import { Log } from '$lib/utils/Log';

  /** Channels of the open community while a drag is in flight; null the rest of the time. */
  let draggedChannels = $state<ChannelItem[] | null>(null);
  /** Screen-reader announcement of the last keyboard move. */
  let channelMoveAnnouncement = $state('');

  /** Whether the drag in flight is really a press on a row - see `channelPressGesture.ts`. */
  const channelPress = createChannelPressTracker();

  function handleChannelDndConsider(e: CustomEvent<DndEvent<ChannelItem>>) {
    channelPress.consider(e.detail.items, e.detail.info.trigger);
    draggedChannels = e.detail.items;
  }

  function handleChannelDndFinalize(
    workspace: ChannelWorkspace,
    e: CustomEvent<DndEvent<ChannelItem>>
  ) {
    draggedChannels = null;
    const outcome = channelPress.finalize(String(e.detail.info.id));
    if (outcome.kind === 'tap') {
      // THE TAP THE DRAG SWALLOWED, delivered exactly as the row's own `onclick` would have: the
      // hold lifted the row from under the finger, so the browser's click never reached it.
      const channel = workspace.channels.find((c) => c.id === outcome.id);
      Log.d('sidebar.channelPressAsTap', { channelId: outcome.id, found: !!channel });
      if (channel) activateChannelRow(channel);
      return;
    }
    onReorderChannels?.(workspace.id, e.detail.items);
  }

  /** What a tap on a salon row does: enter a private salon the admin only sees, else open it. */
  function activateChannelRow(channel: ChannelItem) {
    if (channel.hasAccess === false) onJoinPrivateChannel?.(channel.id, channel.name);
    else onSelectChannelConversation?.(channel.id);
  }

  /** Alt + Up/Down moves the focused salon one place: the keyboard path of the drag. */
  function handleChannelKeydown(
    e: KeyboardEvent,
    workspace: ChannelWorkspace,
    channel: ChannelItem
  ) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const next = moveById(workspace.channels, channel.id, e.key === 'ArrowUp' ? -1 : 1);
    if (!next) return;
    onReorderChannels?.(workspace.id, next);
    channelMoveAnnouncement = m.sidebar_channel_moved_announcement({
      name: channel.name,
      position: next.findIndex((item) => item.id === channel.id) + 1,
      total: next.length,
    });
  }

  interface ChannelItem {
    id: string;
    name: string;
    unreadCount?: number;
    isPrivate?: boolean;
    /** False only on a private salon an admin can SEE but has not joined - see the row below. */
    hasAccess?: boolean;
  }

  interface ChannelWorkspace {
    id: string;
    name: string;
    avatarUserId: string;
    imageMediaId?: string | null;
    workspaceDbId?: string;
    /** Server-authoritative: true when the current user may manage this workspace (MANAGE_WORKSPACE). */
    viewerCanManage?: boolean;
    /** Server-authoritative: true when the user may govern this community's salons, which includes arranging them. */
    viewerCanManageChannels?: boolean;
    channels: ChannelItem[];
  }

  interface Props {
    /** Controls whether the sidebar shows chat conversations or community channels. */
    viewMode?: 'chat' | 'communities';
    /** Map of all loaded conversations keyed by conversation ID. */
    conversations: SvelteMap<string, Conversation>;
    /** List of channel workspaces available in communities view. */
    channelWorkspaces?: ChannelWorkspace[];
    /** ID/name of the currently selected conversation. */
    selectedContact: string | null;
    /** Current value of the new-contact input (controlled). */
    newContactInput: string;
    /** Current value of the new-group name input (controlled). */
    newGroupInput: string;
    /** Current value of the new-channel name input (controlled). */
    newChannelInput?: string;
    /** Callback fired when the contact input value changes. */
    onContactInputChange: (value: string) => void;
    /** Callback fired when the group name input value changes. */
    onGroupInputChange: (value: string) => void;
    /** Callback fired when the channel name input value changes. */
    onChannelInputChange?: (value: string) => void;
    /**
     * Callback to start a direct conversation with the given contact ID.
     *
     * ANSWERS WHETHER IT WORKED, because this panel closes on the answer. It used to return
     * nothing, so the modal closed on every call and a member whose conversation had just been
     * refused was shown a sidebar that had not changed, with no line anywhere saying why.
     */
    onAddContact: (contactId?: string) => Promise<ConversationOutcome>;
    /** Callback to create a new group conversation with the given name. Answers, like `onAddContact`. */
    onCreateGroup: (groupName?: string) => Promise<ConversationOutcome>;
    /** Callback to create a new channel inside the specified workspace. */
    onCreateChannel?: (
      workspaceId: string,
      channelName: string,
      visibility?: 'public' | 'private'
    ) => void;
    /** Callback to create a new community workspace. */
    onCreateWorkspace?: (workspaceName?: string) => void;
    /** Callback to invite a member to a channel with a given role. */
    onInviteChannelMember?: (
      channelId: string,
      memberId: string,
      roleName: 'member' | 'moderator' | 'admin'
    ) => void;
    /** Callback to update the avatar image of a workspace. */
    onUpdateWorkspaceImage?: (workspaceDbId: string, mediaId: string) => void;
    /** Callback fired when the user leaves a workspace. */
    onLeaveWorkspace?: (workspaceDbId: string) => void;
    /** Callback fired when an admin deletes a workspace for every member. */
    onDeleteWorkspace?: (workspaceDbId: string, confirmationName: string) => void;
    /** Callback fired when the user drags a community to a new position in the rail. */
    onReorderCommunities?: (newOrder: ChannelWorkspace[]) => void;
    /**
     * "Marquer tout comme lu" picked from a community's rail menu (long press, right click). Absent,
     * the menu is not offered at all.
     */
    onMarkCommunityRead?: (workspaceId: string) => void;
    /** Callback fired when a salon manager rearranges a community's salons (drag or keyboard). */
    onReorderChannels?: (workspaceSlug: string, newOrder: ChannelItem[]) => void;
    /** Callback fired when the user selects a direct or group conversation. */
    onSelectConversation: (name: string) => void;
    /** Callback fired when the user selects a channel conversation. */
    onSelectChannelConversation?: (channelId: string) => void;
    /** Enters a private salon this admin can see but has not joined. See `joinPrivateChannel`. */
    onJoinPrivateChannel?: (channelId: string, channelName: string) => void;
    /** Callback fired when the user switches to a different community (deselects the open channel). */
    onSelectCommunity?: (workspaceId: string) => void;
    /** ID of the currently active channel. */
    selectedChannelId?: string;
    /** When true, the sidebar is hidden on mobile (shown only on desktop). */
    isHidden?: boolean;
    /** When true, the sidebar renders as a slide-over drawer on mobile. */
    drawerMode?: boolean;
    /** Callback to close the drawer when in drawer mode. */
    onCloseDrawer?: () => void;
    /** ID of the currently authenticated user. */
    currentUserId?: string;
    /** Optional pull-to-refresh handler for the conversations list. */
    onRefresh?: () => Promise<void>;
    /**
     * Whether `onRefresh` has anything to do right now, asked once per gesture.
     *
     * A SPINNER IS A PROMISE THAT SOMETHING IS HAPPENING. This list is fed by the WebSocket, so
     * when the socket is up it is already current and a refresh has no work; showing the spinner
     * then is a lie the user cannot check. Omitted, the gesture stays off entirely.
     */
    canRefresh?: () => boolean;
    /**
     * The community list is drawn from the device before the session is up (F1, the saved
     * snapshot): rows and the rail are shown, and every control that would ACT - reordering the
     * rail, the community settings - is withheld until the session exists; the add button stays
     * (the rail must not move when the session arrives) and its press is answered with a toast.
     */
    previewOnly?: boolean;
    /**
     * The list on screen is the saved snapshot and a listing is refreshing it: said by a quiet
     * spinner in the header, so stale rows are shown AS stale rows being refreshed.
     */
    listRefreshing?: boolean;
  }

  let {
    viewMode = 'chat',
    conversations,
    channelWorkspaces = [],
    selectedContact,
    newContactInput,
    newGroupInput,
    newChannelInput = '',
    onContactInputChange,
    onGroupInputChange,
    onChannelInputChange,
    onAddContact,
    onCreateGroup,
    onCreateChannel,
    onCreateWorkspace,
    onInviteChannelMember,
    onUpdateWorkspaceImage,
    onLeaveWorkspace,
    onDeleteWorkspace,
    onReorderCommunities,
    onMarkCommunityRead,
    onReorderChannels,
    onSelectConversation,
    onSelectChannelConversation,
    onJoinPrivateChannel,
    onSelectCommunity,
    selectedChannelId = '',
    isHidden = false,
    drawerMode = false,
    onCloseDrawer,
    currentUserId = '',
    onRefresh,
    canRefresh,
    previewOnly = false,
    listRefreshing = false,
  }: Props = $props();

  let showNewChatModal = $state(false);
  let showNewChannelModal = $state(false);
  let showCommunityAdminPanel = $state(false);
  let showNewCommunityModal = $state(false);
  let activeTab = $state<'contact' | 'group'>('contact');
  let activeSidebarTab = $derived(
    (viewMode === 'communities' ? 'channels' : 'discussions') as 'channels' | 'discussions'
  );
  let contactId = $state('');
  let groupName = $state('');
  /**
   * The refusal the new-chat panel is currently showing, and whether a creation is in flight.
   *
   * Both are here rather than in the modal because this component owns the submit: the modal is
   * given its state and has no way to learn the outcome of a call it did not make. `newChatBusy`
   * is not cosmetic - a creation takes seconds (device fetch, bulk commit, welcomes), and a panel
   * that stays open with no sign of work reads as one that ignored the click, which is how a
   * second group gets created by a member pressing the button again.
   */
  let newChatError = $state('');
  let newChatBusy = $state(false);
  let channelName = $state('');
  let channelVisibility = $state<'public' | 'private'>('public');
  let communityName = $state('');

  let selectedCommunityWorkspaceId = $state('');
  let searchQuery = $state('');
  const selectedCommunityWorkspace = $derived(
    channelWorkspaces.find((w) => w.id === selectedCommunityWorkspaceId)
  );

  // When a channel is selected externally (e.g. "Rejoindre" button after invite),
  // auto-reveal the workspace that contains it. selectedCommunityWorkspaceId is read via
  // untrack so this effect depends only on the selected channel: without it, a manual
  // community switch (which changes selectedCommunityWorkspaceId while a channel of another
  // community is still open) would re-run this effect and snap the selection right back.
  $effect(() => {
    if (!selectedChannelId || viewMode !== 'communities') return;
    const ws = channelWorkspaces.find((w) => w.channels.some((ch) => ch.id === selectedChannelId));
    if (ws && untrack(() => selectedCommunityWorkspaceId) !== ws.id) {
      selectedCommunityWorkspaceId = ws.id;
    }
  });

  // Auto-select the first workspace when entering communities mode so the
  // gear icon and channel list are immediately visible (avoids an empty panel).
  $effect(() => {
    if (
      viewMode !== 'communities' ||
      selectedCommunityWorkspaceId ||
      channelWorkspaces.length === 0
    )
      return;
    selectedCommunityWorkspaceId = channelWorkspaces[0].id;
  });

  // Clear stale workspace selection if the workspace was removed from the server.
  $effect(() => {
    if (!selectedCommunityWorkspaceId) return;
    if (!channelWorkspaces.some((w) => w.id === selectedCommunityWorkspaceId)) {
      selectedCommunityWorkspaceId = '';
    }
  });

  // Local drag-and-drop order for the community rail. Mirrors `channelWorkspaces` but is only
  // replaced wholesale when membership actually changes (join/leave) - a mid-drag reorder must
  // not be clobbered by the prop re-rendering with the pre-drag server order, and unrelated
  // updates (unread counts, renamed channels) must still refresh the item data in place.
  let orderedWorkspaces = $state<ChannelWorkspace[]>([]);
  $effect(() => {
    const incomingIds = new Set(channelWorkspaces.map((w) => w.id));
    const current = untrack(() => orderedWorkspaces);
    const currentIds = new Set(current.map((w) => w.id));
    const sameMembership =
      incomingIds.size === currentIds.size && [...incomingIds].every((id) => currentIds.has(id));

    orderedWorkspaces = sameMembership
      ? current.map((w) => channelWorkspaces.find((iw) => iw.id === w.id) ?? w)
      : channelWorkspaces;
  });

  /**
   * The community whose rail menu is open, and the icon it is placed against; null when closed.
   * One at a time: opening another closes this one.
   */
  let railMenu = $state<{ workspaceId: string; anchor: HTMLElement } | null>(null);
  /**
   * True from a rail drag's start to its finalize, read from the drag's own `consider` - THE fact
   * that decides whether a hold on an icon is a menu or the start of a reorder. The rail zone has no
   * touch delay, so a finger that drifts 3 px starts a drag well inside the hold's 450 ms; asking
   * the drag rather than tuning a slop to the library's threshold is what keeps the two from both
   * firing.
   */
  let railDragActive = false;

  /** A hold or a right click on a rail icon: opens its menu, unless a drag took the press. */
  function openRailMenu(workspaceId: string, anchor: HTMLElement): boolean {
    if (railDragActive) {
      Log.d('sidebar.railMenu', { workspaceId, opened: false, reason: 'drag in progress' });
      return false;
    }
    Log.d('sidebar.railMenu', { workspaceId, opened: true });
    railMenu = { workspaceId, anchor };
    return true;
  }

  function handleCommunityDndConsider(e: CustomEvent<DndEvent<ChannelWorkspace>>) {
    if (e.detail.info.trigger === TRIGGERS.DRAG_STARTED) {
      railDragActive = true;
      // A hold that became a drag (the finger moved after the menu opened) is a reorder now.
      railMenu = null;
    }
    orderedWorkspaces = e.detail.items;
  }

  function handleCommunityDndFinalize(e: CustomEvent<DndEvent<ChannelWorkspace>>) {
    railDragActive = false;
    orderedWorkspaces = e.detail.items;
    onReorderCommunities?.(orderedWorkspaces);
  }

  interface ChannelItem {
    id: string;
    name: string;
    unreadCount?: number;
    isPrivate?: boolean;
    /** False only on a private salon an admin can SEE but has not joined - see the row below. */
    hasAccess?: boolean;
  }

  /**
   * Every DM/group row, carrying the label the user actually SEES, resolved exactly once.
   *
   * WHY THE PRESENTATION IS RESOLVED HERE RATHER THAN IN THE TEMPLATE. The filter below has to match
   * what the row displays, and for a DM `convo.name` is the PERSISTED KEY (`userId::peerId`), not a
   * human name - the name comes from `resolveConversationListPresentation`. Filtering on `convo.name`
   * therefore matched an id string while the user typed the name printed in front of them, and the
   * conversation they were looking at disappeared as they spelled it. Resolving once here makes the
   * filter and the row read the same value by construction instead of agreeing by coincidence.
   */
  $effect(() => {
    if (!currentUserId) return;
    loadHiddenUnopenable(currentUserId);
    // A hidden conversation seen active once is back on the list for good (review of #2832).
    for (const [name, convo] of conversations) {
      if (convo.lifecycle === 'active') releaseHiddenOnceActive(convo.id || name);
    }
  });

  let conversationRows = $derived.by(() =>
    [...conversations.entries()]
      .filter(([id]) => !isChannelConversationId(id))
      // A conversation its user took off the list because this device can no longer open it (D5)
      // - listed again the moment it opens.
      .filter(([name, convo]) => !isHiddenFromList(convo.id || name, convo.lifecycle))
      .map(([name, convo]) => ({
        name,
        convo,
        resolved: resolveConversationListPresentation(
          {
            id: convo.id || name,
            name: convo.name,
            contactName: convo.contactName,
            conversationType: convo.conversationType,
            directPeerId: convo.directPeerId,
          },
          currentUserId
        ),
      }))
  );

  let filteredConversationEntries = $derived.by(() =>
    conversationRows
      .filter(({ convo, resolved }) =>
        conversationMatchesQuery(
          resolved.displayName,
          previewContentOf(convo.messages) ?? '',
          searchQuery
        )
      )
      .sort((a, b) => compareConversationRecency(a.convo, b.convo))
  );

  /**
   * What "Nouvelle discussion" opens on, built from the rows already resolved above rather than
   * from a second pass over the map - so the picker and the sidebar can never disagree about a
   * person's name. Derived from ALL rows, not the filtered ones: the sidebar's search box has
   * nothing to do with what the modal offers.
   */
  const recentPeers = $derived(
    recentDirectPeers(
      conversationRows.map(({ convo, resolved }) => ({
        resolved,
        lastMessageAt: conversationRecency(convo),
      }))
    )
  );

  function openNewChatModal(tab: 'contact' | 'group' | 'channel' = 'contact') {
    if (tab === 'channel') {
      channelName = newChannelInput || '';
      channelVisibility = 'public';
      showNewChannelModal = true;
    } else {
      activeTab = tab;
      contactId = newContactInput || '';
      groupName = newGroupInput || '';
      newChatError = '';
      showNewChatModal = true;
    }
  }

  function closeNewChatModal() {
    showNewChatModal = false;
    newChatError = '';
  }

  function closeNewChannelModal() {
    showNewChannelModal = false;
    channelName = '';
  }

  function closeCommunityAdminPanel() {
    showCommunityAdminPanel = false;
  }
  // The admin drawer holds a history entry: the system Back closes the drawer, not the community
  // under it. `SidePanel` registers none by design - its other consumer's owner already does
  // (audit of 2026-10-13).
  bindHistoryOverlay(() => showCommunityAdminPanel, closeCommunityAdminPanel);

  /**
   * Runs one creation and decides what the panel does with the answer.
   *
   * THE FIELD IS CLEARED ONLY ON SUCCESS, which is the other half of staying open: a member who is
   * told "this contact has never signed in" is looking at the id they typed, and blanking it would
   * make them type it again to read it. On success the panel closes and the sidebar shows the
   * conversation, which is the signal - no toast is added for it.
   */
  async function runCreation(
    create: () => Promise<ConversationOutcome>,
    clearField: () => void
  ): Promise<void> {
    if (newChatBusy) return;
    newChatBusy = true;
    newChatError = '';
    try {
      const outcome = await create();
      if (!outcome.ok) {
        newChatError = conversationRefusalMessage(outcome.reason);
        return;
      }
      clearField();
      closeNewChatModal();
    } finally {
      newChatBusy = false;
    }
  }

  function handleAddContact() {
    const value = contactId.trim();
    if (!value) return;
    if (currentUserId && value.toLowerCase() === currentUserId.toLowerCase()) return;
    onContactInputChange(value);
    void runCreation(
      () => onAddContact(value),
      () => {
        contactId = '';
        onContactInputChange('');
      }
    );
  }

  function handleCreateGroup() {
    const value = groupName.trim();
    if (!value) return;
    onGroupInputChange(value);
    void runCreation(
      () => onCreateGroup(value),
      () => {
        groupName = '';
        onGroupInputChange('');
      }
    );
  }

  function handleCreateChannel() {
    const value = channelName.trim();
    if (!value) return;
    if (!selectedCommunityWorkspaceId) {
      showToast(m.sidebar_select_community_first(), 'warning');
      return;
    }
    onChannelInputChange?.(value);
    onCreateChannel?.(selectedCommunityWorkspaceId, value, channelVisibility);
    channelName = '';
    channelVisibility = 'public';
    onChannelInputChange?.('');
    closeNewChannelModal();
  }

  function handleCreateWorkspace() {
    const value = communityName.trim();
    if (!value) return;
    onCreateWorkspace?.(value);
    communityName = '';
    showNewCommunityModal = false;
  }
</script>

{#if drawerMode}
  <button
    type="button"
    class="fixed inset-0 z-(--z-nav-drawer-scrim) bg-black/30 md:hidden"
    use:coversScreen
    onclick={() => onCloseDrawer?.()}
    aria-label={m.sidebar_close_panel_aria()}
  ></button>
{/if}

<!--
  NAMED LANDMARK, and the name follows what the panel is actually listing - it is the same region
  showing two different things. See the note on the nav rail in `AppSidebar.svelte`: with both
  asides unnamed, assistive technology announced two indistinguishable "complementary" regions.
-->
<aside
  aria-label={viewMode === 'communities'
    ? m.nav_communities_landmark()
    : m.nav_conversations_landmark()}
  class="sidebar-panel bg-cn-surface flex h-full border-r border-white/50 dark:border-white/10 {viewMode ===
  'communities'
    ? 'flex-row'
    : 'flex-col'} {drawerMode
    ? 'animate-panel-in fixed top-0 bottom-0 left-0 z-(--z-nav-drawer) pt-(--safe-area-inset-top) pb-[var(--safe-area-inset-bottom,0px)] shadow-2xl md:hidden ' +
      (viewMode === 'communities' ? 'w-[95vw] max-w-md' : 'w-[88vw] max-w-sm')
    : viewMode === 'communities'
      ? 'w-full md:w-96'
      : 'w-full md:w-80'} {isHidden && !drawerMode ? 'hidden md:flex' : ''}"
>
  {#if viewMode === 'communities'}
    <div
      class="no-scrollbar mobile-nav-inset flex h-full w-[72px] shrink-0 flex-col items-center gap-3 overflow-y-auto border-r border-white/50 bg-white/20 py-3 dark:border-white/10 dark:bg-black/10"
    >
      <div
        class="flex flex-col items-center gap-3"
        use:dndzone={{
          items: orderedWorkspaces,
          flipDurationMs: 150,
          type: 'community',
          dragDisabled: previewOnly,
        }}
        onconsider={handleCommunityDndConsider}
        onfinalize={handleCommunityDndFinalize}
      >
        {#each orderedWorkspaces as workspace (workspace.id)}
          {@const hasUnread = communityHasUnread(workspace.channels, conversations)}
          <div animate:flip={{ duration: 150 }} class="relative">
            <!-- THE MENU IS A HOLD UNDER A FINGER AND A RIGHT CLICK UNDER A MOUSE (`longPress`), and
                 the mouse's main button is left to the drag: held on an icon, it starts a reorder.
                 The hold swallows the click that ends it - the browser's and the one the drag
                 library dispatches on `touchend` - so opening the menu never also switches
                 community. `select-none` and no touch callout: iOS would otherwise answer the same
                 hold with its own text-selection bubble. -->
            <button
              use:longPress={{
                pointerTypes: ['touch', 'pen'],
                onHold: (anchor) =>
                  onMarkCommunityRead ? openRailMenu(workspace.id, anchor) : false,
                onContextMenu: (anchor) => {
                  if (onMarkCommunityRead) openRailMenu(workspace.id, anchor);
                },
              }}
              aria-haspopup={onMarkCommunityRead ? 'menu' : undefined}
              aria-expanded={onMarkCommunityRead
                ? railMenu?.workspaceId === workspace.id
                : undefined}
              class="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl transition-all duration-200 select-none [-webkit-touch-callout:none] {selectedCommunityWorkspaceId ===
              workspace.id
                ? 'ring-cn-yellow ring-offset-cn-bg ring-2 ring-offset-2'
                : 'opacity-70 hover:rounded-xl hover:opacity-100'}"
              onclick={() => {
                if (selectedCommunityWorkspaceId === workspace.id) return;
                selectedCommunityWorkspaceId = workspace.id;
                // Deselect the currently open channel so nothing is shown until the user
                // explicitly picks a channel in the newly selected community.
                onSelectCommunity?.(workspace.id);
              }}
              title={workspace.name}
              aria-label={hasUnread
                ? `${workspace.name}, ${m.sidebar_community_unread_label()}`
                : workspace.name}
            >
              <GroupAvatar
                id={workspace.id}
                imageMediaId={workspace.imageMediaId}
                name={workspace.name}
                size="lg"
              />
            </button>
            <!-- A SIBLING OF THE BUTTON, NOT A CHILD: the button clips its avatar (`overflow-hidden`)
                 and would clip the dot with it. The state is spoken by the button's own label. -->
            {#if hasUnread}
              <span
                data-community-unread-dot
                aria-hidden="true"
                class="ring-cn-bg pointer-events-none absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-red-500 ring-2"
              ></span>
            {/if}
            {#if railMenu?.workspaceId === workspace.id && onMarkCommunityRead}
              {@const menuWorkspaceId = workspace.id}
              <CommunityRailMenu
                anchor={railMenu.anchor}
                communityName={workspace.name}
                {hasUnread}
                onMarkRead={() => onMarkCommunityRead(menuWorkspaceId)}
                onClose={() => {
                  railMenu = null;
                }}
              />
            {/if}
          </div>
        {/each}
      </div>

      <!-- Drawn before the session too, so the rail does not move when the session arrives; until
           then the press is answered, not acted on (F1 preview). -->
      <div class="my-1 h-[2px] w-8 rounded-full bg-white/30 dark:bg-white/10"></div>

      <button
        onclick={() => {
          if (previewOnly) {
            console.log('[WORKSPACE-SNAPSHOT] add-community pressed before the session');
            showToast(m.communities_wait_for_session(), 'info');
            return;
          }
          showNewCommunityModal = true;
        }}
        class="border-text-muted/50 text-text-muted hover:text-text-main hover:border-text-main flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-dashed transition-all hover:rounded-lg hover:bg-white/10"
        title={m.sidebar_add_community_title()}
        aria-label={m.sidebar_add_community_title()}
      >
        <Plus size={24} />
      </button>
    </div>
  {/if}

  <div class="flex h-full min-w-0 flex-1 flex-col">
    {#if viewMode === 'chat'}
      <SidebarHeaderControls
        {activeSidebarTab}
        {searchQuery}
        {drawerMode}
        {onCloseDrawer}
        onSearchQueryChange={(value) => {
          searchQuery = value;
        }}
        onOpenNewChat={() => openNewChatModal('contact')}
      />
    {:else}
      <div
        class="glass-chrome sticky top-0 z-10 flex items-center justify-between rounded-none border-x-0 border-t-0 border-white/50 px-4 py-3 shadow-none dark:border-white/10"
      >
        <h2 class="text-text-main truncate text-lg font-bold tracking-tight">
          <EmojiText text={selectedCommunityWorkspace?.name || m.sidebar_communities_fallback()} />
        </h2>

        <div class="flex items-center gap-1">
          {#if listRefreshing}
            <span
              data-communities-refreshing
              role="status"
              class="text-text-muted inline-flex"
              title={m.sidebar_communities_refreshing()}
              aria-label={m.sidebar_communities_refreshing()}
            >
              <LoaderCircle size={16} class="animate-spin" />
            </span>
          {/if}
          {#if selectedCommunityWorkspace && !previewOnly}
            <button
              class="ui-icon-button text-text-muted hover:text-text-main hover:bg-cn-surface rounded-full transition-colors dark:hover:bg-black/30"
              onclick={() => {
                showCommunityAdminPanel = true;
              }}
              title={m.sidebar_community_settings_title()}
              aria-label={m.sidebar_community_settings_title()}
            >
              <Settings size={18} />
            </button>
          {/if}

          {#if drawerMode}
            <button
              type="button"
              onclick={() => onCloseDrawer?.()}
              class="ui-icon-button text-text-muted hover:bg-cn-surface rounded-full bg-transparent transition-colors dark:hover:bg-black/30"
              aria-label={m.common_close_label()}
            >
              <X size={18} />
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Conversation List -->
    <div
      class="mobile-nav-inset flex-1 overflow-y-auto p-2.5"
      use:pullToRefresh={{
        onRefresh: onRefresh ?? (() => Promise.resolve()),
        enabled: canRefresh ?? (() => false),
      }}
    >
      {#if activeSidebarTab === 'discussions'}
        {#each filteredConversationEntries as { name, convo, resolved } (name)}
          <div class="relative">
            <ConversationTile
              conversationId={convo.id}
              contactName={resolved.contactId}
              displayName={resolved.displayName}
              displayNameResolved={resolved.displayNameResolved}
              conversationType={convo.conversationType}
              lastMessage={previewContentOf(convo.messages)}
              isReady={convo.lifecycle === 'active'}
              isRemoved={convo.lifecycle === 'removed'}
              awaitingAdmission={isNeverAdmitted(convo)}
              isSelected={selectedContact === name}
              unreadCount={convo.unreadCount ?? 0}
              imageMediaId={convo.imageMediaId}
              onClick={() => onSelectConversation(name)}
            />
          </div>
        {/each}

        {#if filteredConversationEntries.length === 0}
          <div class="text-text-muted px-6 py-12 text-center">
            <div class="mb-4 flex justify-center">
              <div class="rounded-2xl bg-black/5 p-4 dark:bg-white/5">
                <MessageSquarePlus size={36} class="opacity-40" />
              </div>
            </div>
            {#if searchQuery.trim()}
              <p class="text-sm font-medium">{m.chat_no_discussion_found()}</p>
            {:else}
              <p class="text-text-main mb-1 text-sm font-bold">
                {m.sidebar_no_conversations_title()}
              </p>
              <p class="mb-4 text-xs">{m.sidebar_start_writing()}</p>
              <button
                type="button"
                onclick={() => openNewChatModal('contact')}
                class="text-cn-ink rounded-xl bg-amber-500 px-4 py-2 text-xs font-semibold transition-all active:scale-95"
              >
                {m.chat_new_discussion_label()}
              </button>
            {/if}
          </div>
        {/if}
      {:else}
        {@const currentWorkspace = channelWorkspaces.find(
          (w) => w.id === selectedCommunityWorkspaceId
        )}
        {#if currentWorkspace}
          {@const canReorderChannels = currentWorkspace.viewerCanManageChannels === true}
          <div class="px-2 py-2">
            <p class="sr-only" aria-live="polite">{channelMoveAnnouncement}</p>
            {#if canReorderChannels}
              <p id="channel-reorder-hint" class="sr-only">{m.sidebar_channel_reorder_hint()}</p>
            {/if}
            <!-- `keepRowActivationKeys`: each row IS the draggable, and the library takes Enter and
                 Space for a keyboard drag, cancelling the button - Enter opened no salon for whoever
                 may reorder them. Reordering by keyboard is Alt + arrows, never the library's. -->
            <div
              use:keepRowActivationKeys
              use:dndzone={{
                items: draggedChannels ?? currentWorkspace.channels,
                flipDurationMs: 150,
                type: `channels-${currentWorkspace.id}`,
                dragDisabled: !canReorderChannels,
                // A long press, so a swipe on the list still scrolls it; the keyboard path is
                // Alt + arrows on the row, hence no second tab stop on the wrapper.
                delayTouchStart: 350,
                zoneItemTabIndex: -1,
                autoAriaDisabled: true,
                dropTargetStyle: {},
              }}
              onconsider={handleChannelDndConsider}
              onfinalize={(e) => handleChannelDndFinalize(currentWorkspace, e)}
            >
              {#each draggedChannels ?? currentWorkspace.channels as channel (channel.id)}
                {@const unjoined = channel.hasAccess === false}
                {@const unreadCount = channelUnreadCount(channel, conversations)}
                <!-- THE WHOLE ROW IN ONE NAME. Sighted users read three signals here - a lock, a
                   name, a badge - and only the middle one was ever exposed: the icon is decorative
                   markup and the badge announced a bare number, so "general 3" was all a screen
                   reader had. `aria-current` is what says WHICH channel is open; the yellow tint
                   says it to everyone else. -->
                <!--
                WHICH CHANNEL THIS ROW IS, published rather than left to its rendered name. A
                channel called `general` puts that word in a dozen places once its conversation is
                open - the panel header, the pane header, the composer placeholder, every message
                that says it - so anything resolving a row by visible text is choosing among all of
                them, and which one it picks changes as the page settles. That was invisible while
                every channel open went through a full page reload, because a freshly loaded page
                has no messages yet. Same one-attribute cost as `data-conversation-tile`, same
                reason. Measured 2026-09-05: twelve visible elements matched "general".
              -->
                <button
                  type="button"
                  data-channel-row={channel.name}
                  animate:flip={{ duration: 150 }}
                  onkeydown={(e) =>
                    canReorderChannels && handleChannelKeydown(e, currentWorkspace, channel)}
                  aria-keyshortcuts={canReorderChannels ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                  aria-describedby={canReorderChannels ? 'channel-reorder-hint' : undefined}
                  onclick={() => activateChannelRow(channel)}
                  aria-current={selectedChannelId === channel.id ? 'true' : undefined}
                  aria-label={unjoined
                    ? m.chat_channel_join_as_admin_aria({ name: channel.name })
                    : `${
                        channel.isPrivate
                          ? `${m.chat_channel_private_label()} ${channel.name}`
                          : channel.name
                      }${
                        unreadCount
                          ? `, ${m.chat_unread_messages_label({ count: unreadCount })}`
                          : ''
                      }`}
                  class="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors pointer-coarse:min-h-11 {selectedChannelId ===
                  channel.id
                    ? 'text-text-main bg-[color-mix(in_srgb,var(--cn-yellow)_16%,transparent)]'
                    : 'text-text-muted hover:text-text-main hover:bg-cn-surface dark:hover:bg-black/20'}"
                >
                  <span class="opacity-70" aria-hidden="true">
                    {#if channel.isPrivate}
                      <Lock size={16} />
                    {:else}
                      <Hash size={16} />
                    {/if}
                  </span>
                  <span class="flex-1 truncate font-medium {unjoined ? 'opacity-60' : ''}"
                    ><EmojiText text={channel.name} /></span
                  >
                  <!-- The admin sees the salon EXISTS and can enter it in one click. Nothing else is
                     served until they do: no message, no roster, no seed - all three go through
                     `canAccessChannel`, which says no while this row is showing. -->
                  {#if unjoined}
                    <span
                      aria-hidden="true"
                      class="border-text-muted/30 text-2xs rounded-full border px-2 py-0.5 font-semibold tracking-wide uppercase"
                    >
                      {m.chat_channel_join_as_admin_label()}
                    </span>
                  {/if}
                  {#if unreadCount}
                    <span
                      aria-hidden="true"
                      class="bg-cn-ink text-cn-yellow text-2xs inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1 font-bold"
                    >
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  {/if}
                </button>
              {/each}
            </div>

            {#if currentWorkspace?.viewerCanManage}
              <button
                type="button"
                onclick={() => openNewChatModal('channel')}
                class="border-text-muted/30 text-text-muted hover:text-text-main hover:bg-cn-surface mt-2 flex w-full items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-left transition-colors dark:hover:bg-black/20 pointer-coarse:min-h-11"
              >
                <Plus size={16} aria-hidden="true" />
                <span class="text-sm font-medium">{m.chat_add_channel_label()}</span>
              </button>
            {/if}
          </div>
        {:else}
          <div class="text-text-muted px-4 py-8 text-center text-sm">
            {m.sidebar_select_or_create_community()}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</aside>

<SidebarNewChatModal
  open={showNewChatModal}
  {activeTab}
  {contactId}
  {groupName}
  {currentUserId}
  {recentPeers}
  error={newChatError}
  busy={newChatBusy}
  onClose={closeNewChatModal}
  onPickPeer={(peerId) => {
    contactId = peerId;
    handleAddContact();
  }}
  onTabChange={(tab) => {
    activeTab = tab;
    newChatError = '';
  }}
  onContactIdChange={(value) => {
    contactId = value;
  }}
  onGroupNameChange={(value) => {
    groupName = value;
  }}
  onSubmitContact={handleAddContact}
  onSubmitGroup={handleCreateGroup}
/>

<SidebarNewChannelModal
  open={showNewChannelModal}
  {channelName}
  visibility={channelVisibility}
  onClose={closeNewChannelModal}
  onChannelNameChange={(value) => {
    channelName = value;
  }}
  onVisibilityChange={(value) => {
    channelVisibility = value;
  }}
  onSubmitChannel={handleCreateChannel}
/>

<SidebarCommunityAdminPanel
  open={showCommunityAdminPanel}
  workspaces={channelWorkspaces}
  selectedWorkspaceId={selectedCommunityWorkspaceId}
  onClose={closeCommunityAdminPanel}
  {onUpdateWorkspaceImage}
  {onLeaveWorkspace}
  {onDeleteWorkspace}
  onInviteCommunityMember={async (memberId, roleName) => {
    const workspace = selectedCommunityWorkspace;
    if (!workspace) {
      throw new Error('No community selected');
    }

    // The invitation rides on a salon every member can open - the first public one - never on a
    // salon NAME: names are free text and may be changed, the id is the identity.
    const targetChannel =
      workspace.channels.find((channel) => !channel.isPrivate && channel.hasAccess !== false) ??
      workspace.channels[0];

    if (!targetChannel) {
      throw new Error('No channel available in this community to send the invitation');
    }

    await onInviteChannelMember?.(targetChannel.id, memberId, roleName);
  }}
/>

<SidebarNewCommunityModal
  open={showNewCommunityModal}
  {communityName}
  onClose={() => (showNewCommunityModal = false)}
  onNameChange={(value) => {
    communityName = value;
  }}
  onSubmit={handleCreateWorkspace}
/>
