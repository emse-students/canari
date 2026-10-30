/**
 * Reactive composable owning all conversation state and operations:
 * - The conversations SvelteMap
 * - Selection, archive/restore
 * - Group members + membership verification
 * - Group-level operations (create, rename, delete, invite, kick)
 * - Storage helpers (save, load history, reload)
 */
import type { JoinAnswerResult, JoinRequest } from '$lib/utils/chat/joinRequests.svelte';
import {
  admitJoinRequest,
  declineJoinRequest as declineJoinAsk,
  type JoinAnswerDeps,
} from '$lib/utils/chat/joinAnswers';
import { removeStrayLeaves } from '$lib/utils/chat/strayLeaves';
import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { foldForSearch } from '$lib/utils/textFold';
import type { IStorage, StoredMessage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
import { Log } from '$lib/utils/Log';
import type {
  AddMessageToChatOptions,
  MessageBatchOrigin,
  MessageReaction,
  Conversation,
  ChatMessage,
} from '$lib/types';
import { isChannelConversationId } from '$lib/utils/chat/channelCrypto';
import {
  chat_group_remove_member_confirm,
  chat_system_removed_from_group,
  common_remove_label,
} from '$lib/paraglide/messages';
import { showConfirm } from '$lib/stores/confirm.svelte';
import { withMlsBulkIngest } from '$lib/mls-client/mlsBulkIngest';
import { publishConversationRead } from '$lib/mls-client/tabMessageSync';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { resolveConversationKey } from '$lib/utils/chat/openConversationFromId';
import { setPollMeta } from '$lib/stores/pollStore.svelte';
import { applyChannelEdits, type DecodedChannelEdit } from '$lib/utils/chat/channelEdit';
import { createLoadGenerations } from '$lib/utils/chat/loadGenerations';
import { whenSalonEntryDecided } from '$lib/utils/graine/salonSendGate';
import type { ChannelPollMeta } from '$lib/services/ChannelService';
import { applyChannelReactionFrame } from '$lib/stores/reactionStore.svelte';
import {
  fetchGroupRoster,
  fetchUniqueGroupMembers,
  removeMemberAndBroadcast,
  renameGroupAndBroadcast,
  setGroupImageAndBroadcast,
  deleteGroupAndBroadcast,
  leaveGroupAndBroadcast,
  isGroupActiveOnServer,
  purgeOrphanGroup,
  historyRangeStartFor,
  sendHistoryRangeRequest,
} from '$lib/utils/chat/groupActions';
import {
  clearPendingGroupExit,
  classifyExitFailure,
  recordPendingGroupExit,
} from '$lib/utils/chat/pendingGroupExits';
import {
  membershipIsDurablyLost,
  readLocalMembership,
  recordEviction,
  type EvictionEvidence,
} from '$lib/utils/chat/eviction';
import { NotAGroupMemberError } from '$lib/mls-client/mlsDeliveryApi';
import { digestIdentity } from '$lib/utils/chat/historyDigestRendezvous';
import {
  createNewGroup as createGroup,
  inviteMembersToGroup,
  replanLostInvitation,
  startNewConversation as startConversation,
  type ConversationOutcome,
} from '$lib/utils/chat/groupCreation';
import type { OwedInvitationReplanner } from '$lib/mls-client/owedInvitations';
import {
  makeLostInvitationReplanner,
  makeUnrecordedInvitationTeller,
} from '$lib/utils/chat/lostInvitationReplanner';
import { requestReAdd } from '$lib/utils/chat/recovery';
import {
  findConversationKeyByGroupId,
  loadExistingConversations,
  purgeConversation,
  retireConversation,
  toConversationMeta,
  INITIAL_MESSAGES_PAGE,
} from '$lib/utils/chat/conversations';
import { readLandingPreview } from '$lib/utils/chat/landingPreview';
import {
  reportBulkAdditionRefusal,
  reportFollowerTabRefusal,
  reportLostInvitation,
  reportMemberRemovalFailure,
} from '$lib/utils/chat/conversationRefusalMessage';
import { MemberRemovalNotCommittedError } from '$lib/utils/chat/memberRemovalError';
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { parseReadWatermarks } from '$lib/utils/chat/readState';
import { mergeMessagePage } from '$lib/utils/chat/messageMerge';
import { nextEchoMessages } from '$lib/utils/chat/salonEcho';
import { clearUnsentSalonTexts } from '$lib/utils/chat/salonUnsent';
import { noteSalonOpened, reconcileSalonUnreadFromServer } from '$lib/utils/chat/salonUnread';
import {
  flushSalonReadMarks,
  forgetDmReadMark,
  owedSalonReadMarks,
  salonMarksAfterLoad,
} from '$lib/utils/chat/salonReadMarkQueue';
import { drainOutboxForExit } from '$lib/utils/chat/outbox';
import { connectivity } from '$lib/stores/connectivity.svelte';

/** Salons whose "decoded after entry was decided" decision was already logged this session. */
const salonEntryDecisionNoted = new SvelteSet<string>();
import {
  mapStoredMessagesToChatMessages,
  readHistoryStreamCursor,
  replayConversationHistory,
  retroactivelyResolveHexIds,
} from '$lib/utils/chat/history';
import {
  pushHistoryOverlay,
  closeHistoryOverlayFromUi,
  abandonHistoryOverlay,
  isMobileOverlayLayout,
} from '$lib/utils/historyOverlayStack';

/** Messages loaded per scroll-up DB page request. */
const OLDER_MESSAGES_PAGE = 50;

/**
 * How many messages one scrollback ask may bring back.
 *
 * A page, not a store: the reader asks again by scrolling further, so this bounds the answer without
 * bounding what they can eventually reach. Matched to {@link OLDER_MESSAGES_PAGE} so a page fetched
 * from a peer fills the list exactly as a page read from disk does.
 */
const SCROLLBACK_PAGE = OLDER_MESSAGES_PAGE;

/** Runtime dependencies injected into all conversation and group operations. */
export interface ConversationContext {
  /** The live storage instance (null until logged in). */
  storage: IStorage | null;
  /** Returns (or lazily creates) the active MLS service. */
  ensureMls: () => IMlsService;
  userId: string;
  deviceKeyB64: string;
  historyBaseUrl: string;
  messageReactions: SvelteMap<string, MessageReaction[]>;
  log: (msg: string) => void;
  addMessageToChat: (
    senderId: string,
    content: string,
    contactName: string,
    options?: AddMessageToChatOptions
  ) => Promise<void>;
  batchAddMessages?: (
    messages: Array<{ senderId: string; content: string } & AddMessageToChatOptions>,
    contactName: string,
    origin: MessageBatchOrigin
  ) => Promise<void>;
}

/**
 * The four things a conversation can show BESIDE itself.
 *
 * `settings` is a CHANNEL's settings and `conversation` is a group's or a DM's - two screens
 * reached from the same gear icon, which is exactly why they had ended up as two different
 * mechanisms: a modal for one, a portalled sheet the header mounted itself for the other.
 *
 * A closed set rather than a string, because every consumer switches on it and a typo would
 * silently render nothing.
 */
export type ConversationSidePanelKind = 'members' | 'media' | 'settings' | 'conversation';

/** Creates and returns the reactive conversation store with all selection, history, group, and storage operations. */
export function useConversations() {
  const conversations = new SvelteMap<string, Conversation>();

  // ── UI state ──────────────────────────────────────────────────────────────
  let selectedContact = $state<string | null>(null);
  let isConversationDrawerOpen = $state(false);
  /**
   * WHICH conversation side panel is open, and there is only ever one.
   *
   * This was three separate booleans living in three places - a members flag here, a
   * `showMediaPanel` local inside `ChatArea`, and a settings-modal flag here - so opening the media
   * sheet over an already-open members column was a state nothing forbade, and each of the three
   * drew itself with a different mechanism. One value cannot hold two panels open, which is the
   * point: the illegal state stopped being reachable rather than being guarded against.
   *
   * Desktop (xl+) starts with the members panel showing, which is the behaviour the members column
   * already had; the drawer form must start closed.
   */
  let sidePanel = $state<ConversationSidePanelKind | null>(
    isMobileOverlayLayout() ? null : 'members'
  );
  let groupMembers = $state<string[]>([]);
  // Optimistic invite feedback: user IDs with an add-member operation in flight,
  // keyed by group so a mid-invite conversation switch never leaks pending rows.
  let pendingInvites = $state<{ groupId: string; ids: string[] } | null>(null);
  let isLoadingHistory = $state(false);
  // True once THIS session's IndexedDB restore has populated the map, so consumers (e.g. the
  // /posts mini-panel) can treat the live map as authoritative and reflect deletions
  // instead of resurrecting stale rows from their own snapshot. Reset at sign-out
  // (`invalidateRestores`), when the map is cleared.
  let conversationsRestored = $state(false);
  /**
   * How many startup/resume passes that can still ADD a conversation are running.
   *
   * `conversationsRestored` answers "has IndexedDB been read into the map", and a deep-link landing
   * used it to answer a DIFFERENT question - "is the set of this device's conversations complete".
   * Those differ by exactly the FCM cache, which runs AFTER the restore and is the only way a first
   * message from a new correspondent reaches the map at all. So the landing saw a settled map
   * without the target, concluded the conversation was not on this device, and abandoned - a few
   * milliseconds before `consumeFcmCache` wrote the placeholder that would have satisfied it. The
   * tap opened the app on nothing, which is precisely what was reported from production.
   *
   * Counted rather than flagged because the same span runs at login and again on every resume, and
   * because the next source to be added must be able to say so without teaching the landing about
   * itself. Zero means nothing is running, NOT that anything has run - which is why the settled
   * predicate still requires the restore.
   */
  let pendingConversationSources = $state(0);
  /**
   * The conversation drawn from the LOCAL store while the session is not up yet - the notification
   * landing's target (F1, `landingPreview.ts`). Null whenever a session owns the map, or when there
   * is nothing to preview. While it is set the chat page is drawn without a session, so it is the
   * one fact every pre-session render decision reads, and it is cleared by the three events that end
   * it: the session coming up (`endLandingPreview`), the login failing or the landing being left
   * (`discardLandingPreview`), and the restore that rebuilds the map.
   */
  let landingPreviewKey = $state<string | null>(null);
  /**
   * The login that drew {@link landingPreviewKey}. Two logins can overlap (the first one ending
   * while a second has started), and a failing login must remove ITS preview and never the one the
   * next login drew - so a discard names its owner and is a no-op for anybody else's.
   */
  let landingPreviewOwner: number | null = null;
  let sendError = $state('');

  // ── Input state ───────────────────────────────────────────────────────────
  let newContactInput = $state('');
  let newGroupInput = $state('');
  let newChannelInput = $state('');
  let chatContainer = $state<HTMLElement | undefined>(undefined);

  // Short-lived cache so rapid successive sends don't re-check membership via HTTP
  const membershipCache = new SvelteMap<string, { isMember: boolean; expiresAt: number }>();
  /**
   * Which channel histories are CURRENT in memory, and for which user.
   *
   * A salon's in-memory copy is the REST page plus every live socket event since - so it is current
   * exactly as long as that stream has had no gap, and it says nothing about a clock. It used to be
   * trusted for five minutes after its load, which is a proof of nothing: a salon open across a
   * background lost every message posted while the socket was paused (they arrive as pushes, which
   * write no salon row), and showed none of them until the five minutes ran out. Measured on a
   * Mi 9T, 2026-10-01. An entry now leaves this map only through an event that makes it stale -
   * {@link noteLiveStreamTransition}, a deletion, a kick, a Graine repair.
   */
  const channelHistoryLoadedAt = new SvelteMap<string, { loadedAt: number; userId: string }>();
  /** Orders overlapping history loads of one salon: only the latest started merges its page. */
  const salonLoadGenerations = createLoadGenerations();
  /**
   * The generation of the salon load that last RAISED the skeleton, which is the one that lowers it.
   * Not "the latest load of that salon": a newer load started while the salon is NOT on screen (a
   * Graine repair after the reader switched away) raises nothing, so the superseded load that did
   * would otherwise leave `isLoadingHistory` up for good.
   */
  let salonSkeletonOwner = 0;
  /**
   * The salon whose load raised the skeleton, or `null` for a load with no salon identity (the DM
   * path). A load issued at the tap raises it BEFORE its salon is selected, and a second press within
   * the frame can select another salon: the skeleton is shown only on the salon it was raised for.
   */
  let skeletonSalon: string | null = null;
  /**
   * How many times a salon copy was declared stale ({@link invalidateChannelHistoryCache}, any
   * salon). A load in flight is JOINED by a second non-forced load of the same salon only when its
   * request has not left yet, or left after the last such declaration - then its page already
   * answers whatever made the copy stale (a stream gap, a seed that arrived), and a second request
   * would only download and decode the same 200 rows again and supersede the first.
   *
   * Measured on the Mi 9T (2026-10-14): a salon tapped as soon as its row is drawn, while the live
   * stream comes back and the community listing ends, fetched its 116 kB page two or three times;
   * the extra copies cost ~3 s before the first message at 1x.
   */
  let salonStaleDeclarations = 0;
  /** The load of each salon still in flight: its request's declaration count (`null`: not sent). */
  const salonLoadsInFlight = new SvelteMap<
    string,
    { sentAt: number | null; generation: number; done: Promise<void> }
  >();
  /**
   * The rows of each salon drawn from the store that no server page has confirmed yet (F4).
   *
   * OWNED BY THE SALON, NOT BY THE LOAD THAT DREW THEM. A load that drew the copy and was then
   * superseded never merges, and the newer load finds those rows already in memory and draws nothing -
   * so when the draw was the load's own, NEITHER withdrew a row the server no longer serves, and a
   * refused or deleted message stayed on screen (GRAINE-AUTH-1, 2026-10-22). Whichever load merges
   * withdraws every row here its page does not name, then clears the entry.
   */
  const salonRowsDrawnUnconfirmed = new SvelteMap<string, SvelteSet<string>>();

  /**
   * The sign-out half of `salonRowsDrawnUnconfirmed`: the ending account's unconfirmed draws go with
   * its conversations, so its failed load can never withdraw a row from the next account's page.
   */
  function forgetUnconfirmedSalonDraws(): void {
    Log.d('CHANNEL', `forgetting ${salonRowsDrawnUnconfirmed.size} salon(s) of unconfirmed draws`);
    salonRowsDrawnUnconfirmed.clear();
  }

  function invalidateChannelHistoryCache(channelConversationId?: string) {
    salonStaleDeclarations++;
    if (channelConversationId) channelHistoryLoadedAt.delete(channelConversationId);
    else channelHistoryLoadedAt.clear();
  }

  /**
   * The live stream went down or came back, and every salon copy held against it is stale.
   *
   * BOTH TRANSITIONS COUNT. Losing the socket is the gap itself: whatever a peer posts until it
   * returns reaches this device as a push at best, which renders a banner and writes no salon row.
   * Regaining it does not close a gap opened by a page loaded WHILE it was down, because what was
   * posted between that page and the reconnect is in neither. So both clear every entry, and the
   * reconnect also reloads the salon on screen - the only one a reader is looking at, and the only
   * one nothing else would reload: re-tapping the open salon from its notification selects nothing
   * new. Every other salon is reloaded by its own next selection.
   *
   * @param connected whether the live stream is up after this transition.
   */
  async function noteLiveStreamTransition(connected: boolean, ctx: ConversationContext) {
    invalidateChannelHistoryCache();
    if (!connected) return;
    // WHAT ARRIVED WHILE THE SOCKET WAS DOWN reached no salon row and so raised no badge. The server
    // counted it against the reader's marks; ask before anything else, for every salon.
    const { channelService } = await import('$lib/services/ChannelService');
    await reconcileSalonUnreadFromServer({
      conversations,
      selectedId: selectedContact,
      userId: ctx.userId,
      fetchCounts: () => channelService.listUnreadCounts(),
      settleOwedMarks: () =>
        flushSalonReadMarks(ctx.userId, (id, at, serverAt) =>
          channelService.advanceReadMark(id, at, serverAt)
        ),
      log: ctx.log,
      reason: 'live stream back',
    });
    const open = selectedContact;
    if (!open || !isChannelConversationId(open)) return;
    ctx.log(`[CHANNEL] live stream back - reloading open salon ${open.slice(8, 16)}`);
    await loadChannelHistory(open, ctx);
  }

  let mobileConvoHistoryClose: (() => void) | null = null;
  let drawerHistoryClose: (() => void) | null = null;
  /** What the app owns OUTSIDE this composable that leaving a thread ends (the salon selection). */
  let threadLeftListener: (() => void) | null = null;

  /**
   * Registers the teardown that leaving a thread owes outside this composable. ONE listener, called
   * by BOTH exits - the in-app back and the history close (Android's Back, the iOS edge swipe): the
   * salon row stayed highlighted after a Back because only the in-app back cleared it.
   */
  function onThreadLeft(listener: () => void) {
    threadLeftListener = listener;
  }

  /** The state every way out of a thread ends: the selection, the drawer, the landing, the salon. */
  function leaveThread() {
    // Backing out of the thread ends any landing, or the target would be re-selected instantly.
    endLandingUnlessTarget(null);
    selectedContact = null;
    isConversationDrawerOpen = false;
    threadLeftListener?.();
  }
  let sidePanelHistoryClose: (() => void) | null = null;

  function ensureMobileConvoHistory() {
    if (!isMobileOverlayLayout() || !selectedContact || mobileConvoHistoryClose) return;
    mobileConvoHistoryClose = () => {
      mobileConvoHistoryClose = null;
      // IT ENDS THE LANDING, FOR THE REASON `goBackToMenu` ALREADY SPELLS OUT: "or the target would
      // be re-selected instantly". There are two ways out of a thread - the in-app back control,
      // which goes through `goBackToMenu`, and the HARDWARE Back press, which arrives here - and
      // only one of them ended it. So Back out of a notification landing deselected the
      // conversation and the landing effect immediately put it back.
      //
      // MEASURED ON AN ANDROID HANDSET 2026-09-21: after the tap, the first Back press left the app
      // in the foreground still showing the conversation, and the second exited. Nothing on screen
      // said a press had been consumed at all.
      leaveThread();
    };
    pushHistoryOverlay(mobileConvoHistoryClose);
  }

  function ensureDrawerHistory() {
    if (!isMobileOverlayLayout() || !isConversationDrawerOpen || drawerHistoryClose) return;
    drawerHistoryClose = () => {
      drawerHistoryClose = null;
      isConversationDrawerOpen = false;
    };
    pushHistoryOverlay(drawerHistoryClose);
  }

  function ensureSidePanelHistory() {
    if (!isMobileOverlayLayout() || !sidePanel || sidePanelHistoryClose) return;
    sidePanelHistoryClose = () => {
      sidePanelHistoryClose = null;
      sidePanel = null;
    };
    pushHistoryOverlay(sidePanelHistoryClose);
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  /**
   * Resolves the open conversation synchronously.
   *
   * READ BY KEY, NEVER BY ITERATION. `SvelteMap.get(key)` tracks that key's own source - bumped when
   * the key is set to a new value or deleted - plus the map's version while the key is absent, so it
   * also sees the conversation arrive. Iterating the map, which this used to do, subscribes to EVERY
   * key's source: a message landing in any of a heavy account's ~220 conversations and salons re-ran
   * this, handed ChatArea a new object, and regrouped the open thread's whole history (`groupMessages`,
   * the seen-by pass, the poll parse, the unread count) - several full passes over a 5k-message thread
   * per frame received elsewhere. Every write path stores a NEW object (`set(key, { ...convo, ... })`),
   * which is what a key source compares; a same-object `set` never notified anybody, iterated or not.
   *
   * Shallow-clones the entry so prop consumers (ChatArea on Android WebView) see a fresh reference
   * whenever the open conversation itself changes.
   */
  const currentConvo = $derived.by(() => {
    const key = selectedContact;
    if (!key) return null;
    const v = conversations.get(key);
    if (!v) return null;
    return { ...v, messages: v.messages };
  });

  /**
   * Clears selection when the map no longer has the key (reload, migration, channel kick).
   * `$effect.root` - this composable is instantiated at module load in `globalChatSingleton`.
   *
   * A key absent from the map does NOT always mean the conversation is gone: the map is emptied
   * and rebuilt wholesale by the IndexedDB restore, and pruned on every community refetch, so a
   * deep-link target is routinely missing for as long as a network round trip. Clearing then is
   * what left every deep link in the right tab with nothing open. While the target is still being
   * landed the selection is kept, and the landing itself decides when to give up.
   */
  $effect.root(() => {
    $effect(() => {
      const key = selectedContact;
      if (!key) return;
      if (!conversations.has(key)) {
        if (notifNav.pending === key) return;
        // SAID OUT LOUD, because from the outside this is a tap that did nothing: a salon row the
        // sidebar still lists, selected and dropped in the same frame. A selection of a key the map
        // never had is the visible end of a row lost upstream (`restoreKeepsSalonRows.test.ts`).
        console.warn(
          `[SELECT] ${key.slice(0, 16)} is not in the conversation map - selection dropped, nothing opens`
        );
        selectedContact = null;
        sendError = '';
      }
    });
  });

  // ── Storage helpers ───────────────────────────────────────────────────────

  /** Persists a conversation's metadata row (see `toConversationMeta` for what it carries). */
  async function saveConversation(id: string, ctx: ConversationContext) {
    if (!ctx.storage) return;
    const convo = conversations.get(id);
    if (!convo) return;
    await ctx.storage.saveConversation(toConversationMeta(id, convo, ctx.userId));
  }

  /**
   * Renders the newest STORED page of a conversation into the map, with nothing fetched.
   *
   * Three callers now, and two of them held this block copied out verbatim: the `limit=1` fast path
   * when the server has nothing new, and the reload that follows a replay. The third is a
   * conversation whose group is gone, for which there is no other option at all.
   *
   * `page` is passed by the caller that has already read it, so extracting this costs no second
   * IndexedDB read on the path whose whole purpose is to be cheap.
   *
   * `supersedes` names the rows an EARLIER draw of this same load put on screen. Any of them that
   * fall below the window of this page are withdrawn: when the replay in between brought more than
   * a page, keeping them would leave a hole between the two windows that the scrollback never fills
   * (it pages below the OLDEST row in memory), and a row the replay edited or deleted down there
   * would stay stale. Withdrawing them gives exactly the screen a load that never drew first gives.
   *
   * @returns the rows of the page drawn, so a later draw of the same load can supersede them.
   */
  async function renderStoredPage(
    contactName: string,
    id: string,
    ctx: ConversationContext,
    page?: Awaited<ReturnType<NonNullable<ConversationContext['storage']>['getMessagesPage']>>,
    supersedes?: readonly ChatMessage[]
  ): Promise<ChatMessage[]> {
    if (!ctx.storage) return [];
    const stored =
      page ?? (await ctx.storage.getMessagesPage(id, ctx.deviceKeyB64, INITIAL_MESSAGES_PAGE));
    const msgs = await retroactivelyResolveHexIds(
      mapStoredMessagesToChatMessages(stored, ctx.userId),
      ctx.storage,
      id,
      ctx.deviceKeyB64
    );
    const current = conversations.get(contactName);
    if (!current) return msgs;
    let base = current.messages;
    if (supersedes && supersedes.length > 0 && msgs.length > 0) {
      const oldest = [...msgs].sort(compareMessageOrder)[0];
      const inPage = new SvelteSet(msgs.map((m) => m.id));
      const withdrawn = new SvelteSet(
        supersedes
          .filter((m) => !inPage.has(m.id) && compareMessageOrder(m, oldest) < 0)
          .map((m) => m.id)
      );
      if (withdrawn.size > 0) {
        ctx.log(
          `[HISTORY] ${id.slice(0, 8)}… ${withdrawn.size} early-drawn row(s) below the fresh page withdrawn`
        );
        base = base.filter((m) => !withdrawn.has(m.id));
      }
    }
    conversations.set(contactName, {
      ...current,
      messages: mergeMessagePage(base, msgs),
    });
    for (const m of msgs) {
      if (m.reactions && m.reactions.length > 0) ctx.messageReactions.set(m.id, m.reactions);
    }
    return msgs;
  }

  /** Fetches and decrypts conversation history from the network, then reloads the latest page from IndexedDB. For channel conversations delegates to loadChannelHistory instead of MLS replay. */
  async function loadHistoryForConversation(
    contactName: string,
    id: string,
    ctx: ConversationContext,
    options?: { force?: boolean; atTap?: boolean }
  ) {
    // Channel conversations: load via REST API instead of MLS replay
    if (isChannelConversationId(contactName)) {
      await loadChannelHistory(contactName, ctx, options?.force, options?.atTap);
      return;
    }

    // A CONVERSATION WHOSE GROUP IS GONE HAS NO SERVER HISTORY, AND ASKING FOR IT COSTS A 403.
    //
    // The row is kept at `lifecycle: 'removed'` on purpose, so the UI can explain the absence
    // instead of a conversation silently vanishing - which means a real user really does open one,
    // and every open fired `GET /api/mls/history/<id>` at a group the server has soft-deleted and
    // refuses every read on. `fetchHistory` swallows any non-ok status into an empty page, so the
    // refusal was invisible in the app and visible only as a console error nobody could attribute.
    // Measured on DEL-2 and DEL-3, 2026-09-05: the request went out ELEVEN SECONDS after the
    // deletion the client itself had performed, so it is not a request that was already in flight.
    //
    // This is the same predicate the send path already uses for the same reason
    // (`sendChatMessage`'s "only hard block"): what is on disk is all there will ever be.
    if (conversations.get(contactName)?.lifecycle === 'removed') {
      await renderStoredPage(contactName, id, ctx);
      return;
    }

    const isSelected = selectedContact === contactName;
    if (isSelected) {
      isLoadingHistory = true;
      skeletonSalon = null;
    }
    // The rows the fast path drew before the probe, which the reload after a replay supersedes.
    let drawnFirst: ChatMessage[] = [];
    try {
      // Fast-path: when user clicks a conversation, probe the server cursor with `limit=1`.
      // If there is nothing new, skip the heavy decrypt/replay.
      //
      // THE STORED PAGE IS DRAWN BEFORE THE PROBE, NOT AFTER IT. The probe answers "is there
      // anything newer than what this device holds", and a notification tap is exactly the case
      // where the answer is yes - so the page waited for the probe AND the whole replay behind it,
      // and the reader looked at an empty thread over history that was already on disk (Mi 9T,
      // cold landing: ~0.7 s between the pane and its first row, docs/wiki/frontend/
      // notification-to-conversation-latency.md). The replay below merges what it adds into this
      // page (`mergeMessagePage`), so drawing first changes WHEN the held rows appear, never which.
      if (!options?.force && ctx.storage) {
        const cursor = readHistoryStreamCursor(ctx.userId, id);
        if (cursor) {
          const existingPage = await ctx.storage.getMessagesPage(
            id,
            ctx.deviceKeyB64,
            INITIAL_MESSAGES_PAGE
          );
          // If local DB is empty, let `replayConversationHistory` handle cursor reset safely.
          if (existingPage.length > 0) {
            drawnFirst = await renderStoredPage(contactName, id, ctx, existingPage);
            ctx.log(
              `[HISTORY] ${id.slice(0, 8)}… stored page drawn (${existingPage.length} row(s)) before the server probe`
            );
            try {
              const probe = await ctx.ensureMls().fetchHistory(id, cursor, 1);
              if (probe.rows.length === 0) {
                return;
              }
            } catch (e) {
              // Not a decision: the replay below asks the server itself and reports its own
              // failure. This line is all that is left of the probe's.
              ctx.log(
                `[HISTORY] ${id.slice(0, 8)}… probe failed (${String(e)}), replaying in full`
              );
            }
          }
        }
      }

      // Fetch from network → decrypt → save to DB (no direct UI update).
      // The replay runs in a bulk-ingest window; its progress markers are committed by the helper
      // once a checkpoint that started after the replay LANDED, and never when that checkpoint
      // fails. The page below is drawn without waiting for the disk.
      try {
        await withMlsBulkIngest(
          ctx.ensureMls(),
          () =>
            replayConversationHistory({
              mlsService: ctx.ensureMls(),
              id,
              contactName,
              userId: ctx.userId,
              deviceKey: () => ctx.deviceKeyB64,
              storage: ctx.storage,
              getConversation: (name) => conversations.get(name),
              setConversation: (name, next) => conversations.set(name, next),
              saveConversation: (name) => saveConversation(name, ctx),
              messageReactions: ctx.messageReactions,
              log: ctx.log,
            }),
          (commit) => commit()
        );
        // Reload from DB so display reflects the latest saved state
        await renderStoredPage(contactName, id, ctx, undefined, drawnFirst);
      } catch (e) {
        // Previously unhandled: this call is fired with `void` by every caller, so a throw here
        // (network hiccup, decrypt error, IndexedDB contention - all realistic during a
        // cold-started app's many concurrent init steps) left `conversation.messages` never
        // updated, with NOTHING logged anywhere - the empty conversation this leaves behind had
        // no trace of why. `isLoadingHistory` still clears via `finally` below, so the skeleton
        // stops showing regardless, which is exactly what made this indistinguishable from a
        // conversation that genuinely has no history.
        ctx.log(`[HISTORY] History load failed (${id.slice(0, 8)}…): ${String(e)}`);
      }
    } finally {
      if (isSelected) isLoadingHistory = false;
    }
  }

  /**
   * Draws a salon's last page from this device's store, before its server page (F4 of
   * community-open-budget). Only on the first draw of the salon in this process - a salon already in
   * memory has newer rows than any copy - and only for the load still the latest. The rows it draws
   * join `salonRowsDrawnUnconfirmed`, which the next server page merged confirms or withdraws.
   *
   * Never fatal: a store that cannot be read costs the early draw, said in the log, and the server
   * page draws the salon as it always did.
   */
  async function drawStoredSalonPage(
    channelConversationId: string,
    ctx: ConversationContext,
    generation: number
  ): Promise<void> {
    if (!ctx.storage) return;
    const salonTag = channelConversationId.slice(0, 16);
    if (conversations.get(channelConversationId)?.messages.some((m) => !m.status)) {
      Log.d('CHANNEL', `${salonTag} stored page not drawn - rows already on screen`);
      return;
    }
    let stored: Awaited<ReturnType<NonNullable<ConversationContext['storage']>['getMessagesPage']>>;
    try {
      stored = await ctx.storage.getMessagesPage(
        channelConversationId,
        ctx.deviceKeyB64,
        INITIAL_MESSAGES_PAGE
      );
    } catch (e) {
      ctx.log(
        `[CHANNEL] stored page of ${salonTag} not read - the server page draws it: ${String(e)}`
      );
      return;
    }
    // An empty stored page is every first open of a salon: nothing to draw is no event, and the
    // server page that follows is what draws (and logs) the salon.
    if (stored.length === 0) return;
    if (!salonLoadGenerations.isLatest(channelConversationId, generation)) {
      Log.d('CHANNEL', `${salonTag} stored page not drawn - a newer load started meanwhile`);
      return;
    }
    const current = conversations.get(channelConversationId);
    if (!current) {
      Log.d('CHANNEL', `${salonTag} stored page not drawn - the salon left memory meanwhile`);
      return;
    }
    const drawn = mapStoredMessagesToChatMessages(stored, ctx.userId);
    conversations.set(channelConversationId, {
      ...current,
      messages: mergeMessagePage(current.messages, drawn),
    });
    const pending = salonRowsDrawnUnconfirmed.get(channelConversationId) ?? new SvelteSet<string>();
    for (const m of drawn) pending.add(m.id);
    salonRowsDrawnUnconfirmed.set(channelConversationId, pending);
    ctx.log(
      `[CHANNEL] ${salonTag} stored page drawn (${drawn.length} row(s)) before the server page`
    );
  }

  /**
   * Replaces a salon's stored page with the page the server just gave (F4). The store is a COPY of
   * the last page drawn, never a source: what it held is deleted only now, once a newer page is in
   * hand, so an open that fails keeps the last one for the next open (and offline). `page` is the
   * server's rows alone: the caller has taken the older-messages notice out, and an unsent echo is
   * never in a server page. An empty page empties the copy.
   */
  async function storeSalonPage(
    channelConversationId: string,
    page: readonly ChatMessage[],
    ctx: ConversationContext
  ): Promise<void> {
    if (!ctx.storage) return;
    const rows: StoredMessage[] = page.map((m) => ({
      id: m.id,
      conversationId: channelConversationId,
      senderId: m.senderId,
      content: m.content,
      timestamp: m.timestamp.getTime(),
      ...(m.serverTimestamp !== undefined ? { serverTimestamp: m.serverTimestamp } : {}),
      ...(m.isEdited ? { isEdited: true } : {}),
      ...(m.editedAt ? { editedAt: m.editedAt.getTime() } : {}),
      ...(m.isDeleted ? { isDeleted: true } : {}),
    }));
    try {
      await ctx.storage.deleteMessagesForConversation(channelConversationId);
      if (rows.length > 0) await ctx.storage.saveMessages(rows, ctx.deviceKeyB64);
    } catch (e) {
      ctx.log(
        `[CHANNEL] page of ${channelConversationId.slice(0, 16)} not stored - the next open waits for the server: ${String(e)}`
      );
    }
  }

  /**
   * Loads a salon's history from the server, the source of truth, after drawing the last page this
   * device stored for it (F4). The stored page is a copy the server page replaces: every row drawn
   * from it that the server page does not name is withdrawn, whatever its place in the window.
   */
  async function loadChannelHistory(
    channelConversationId: string,
    ctx: ConversationContext,
    force = false,
    atTap = false
  ) {
    const { channelService } = await import('$lib/services/ChannelService');
    const { decodeChannelMessagePage, UnreadableRowTally, V1_SESSION_NOT_HELD } =
      await import('$lib/utils/chat/channelCrypto');
    const { olderMessagesNotice, olderMessagesNoticeId, keepNoticeOnTop } =
      await import('$lib/utils/chat/olderMessagesNotice');

    const rawId = channelConversationId.replace(/^channel_/, '');
    const convo = conversations.get(channelConversationId);
    if (!convo) return;

    // Current until an event says otherwise - see `channelHistoryLoadedAt`.
    const cached = channelHistoryLoadedAt.get(channelConversationId);
    if (!force && cached && cached.userId === ctx.userId) return;

    // A LOAD OF THIS SALON STILL IN FLIGHT ANSWERS THIS ONE when nothing was declared stale after its
    // request left (see `salonStaleDeclarations`): joined, not repeated.
    const running = salonLoadsInFlight.get(channelConversationId);
    if (
      !force &&
      running &&
      (running.sentAt === null || running.sentAt === salonStaleDeclarations)
    ) {
      ctx.log(
        `[CHANNEL] history load of ${channelConversationId.slice(0, 16)} joins the one in flight (${running.sentAt === null ? 'not sent yet' : 'sent after the last stale mark'})`
      );
      // A press joining a load started in the background (the listing's end, a reconnect) still
      // shows the skeleton: the joined load becomes its owner, and lowers it when its page is in.
      if (atTap || selectedContact === channelConversationId) {
        isLoadingHistory = true;
        salonSkeletonOwner = running.generation;
        skeletonSalon = channelConversationId;
      }
      await running.done;
      return;
    }
    // ONLY THE LATEST LOAD STARTED FOR THIS SALON MAY MERGE (found reviewing #1761). The page is
    // authoritative for its window, so an older load finishing last would drop a row a newer one
    // had just decoded - see `loadGenerations.ts` for the exact sequence. Not a refetch afterwards:
    // that was the heal that hid the race.
    const generation = salonLoadGenerations.begin(channelConversationId);
    let finishLoad: () => void = () => {};
    const inFlight = {
      sentAt: null as number | null,
      generation,
      done: new Promise<void>((resolve) => (finishLoad = resolve)),
    };
    salonLoadsInFlight.set(channelConversationId, inFlight);
    // `atTap`: the request leaves on the press, BEFORE the pane that will show this salon is mounted
    // (the selection follows the pressed row's frame). The skeleton is raised all the same, so the
    // pane mounts onto it instead of onto an empty list.
    const isSelected = atTap || selectedContact === channelConversationId;
    if (isSelected) {
      isLoadingHistory = true;
      salonSkeletonOwner = generation;
      skeletonSalon = channelConversationId;
    }

    try {
      // Nothing to hydrate: a Graine seed is already in the local store or it is not, and the
      // server holds none to fetch. A row this device has no seed for is REPORTED unreadable by
      // `decodeChannelMessagePage` rather than silently skipped, and repaired by WP-33.
      //
      // THE READ MARKS COME WITH EVERY LOAD, beside the page they describe: the live `channel.read`
      // events only carry what moved while this device was connected, so a load is the one moment
      // the whole picture can be taken. Their failure costs the "Lu par" row and nothing else - the
      // page still loads, and the next load asks again.
      inFlight.sentAt = salonStaleDeclarations;
      // SETTLED INTO A VALUE, so the request may fail while the stored page is still being read
      // without an unhandled rejection; its failure is rethrown below, where it always was.
      const pageRequest = Promise.all([
        channelService.listMessages(rawId, 200),
        channelService.listReadMarks(rawId).catch((e) => {
          console.warn(
            `[CHANNEL_READ] read marks of ${rawId.slice(0, 8)} not loaded - who read what stays` +
              ` unknown here until the next load: ${String(e)}`
          );
          return undefined;
        }),
      ]).then(
        (answer) => ({ ok: true as const, answer }),
        (error: unknown) => ({ ok: false as const, error })
      );
      // THE STORED PAGE IS DRAWN WHILE THE SERVER PAGE IS ON THE WIRE (F4): the request has left.
      await drawStoredSalonPage(channelConversationId, ctx, generation);
      const settledPage = await pageRequest;
      if (!settledPage.ok) throw settledPage.error;
      const [rows, rawMarks] = settledPage.answer;
      // DECODED ONLY ONCE NO LISTING CAN STILL ENTER THIS SALON: a row missing its seed asks for it
      // on the community's key group, which a listing still in flight may not have registered yet
      // (`whenSalonEntryDecided`). The page was fetched meanwhile, so an entered salon waits nothing.
      // Said ONCE per salon per session: it is the decision (the page waited for an entry), and the
      // same salon re-reading on every open repeated it (5 lines in one measured row).
      if ((await whenSalonEntryDecided(rawId)) && !salonEntryDecisionNoted.has(rawId)) {
        salonEntryDecisionNoted.add(rawId);
        ctx.log(`[CHANNEL] page of ${rawId.slice(0, 8)} decoded after its salon entry was decided`);
      }
      const loaded: ChatMessage[] = [];
      // Server row id -> the client UUID its author sealed inside it (own rows only, see below).
      const clientIdOf = new SvelteMap<string, string>();
      const edits: DecodedChannelEdit[] = [];
      // Applied only once this load is known to be the latest: a superseded load read its rows
      // EARLIER, and `setPollMeta` overwrites - so its tallies would undo the newer load's.
      const pollMetas: [string, ChannelPollMeta][] = [];
      const meLower = ctx.userId.toLowerCase();

      const tally = new UnreadableRowTally(rawId);

      if (Array.isArray(rows)) {
        // The page's signatures cost ONE engine call, not one per row (F7).
        const decodedRows = await decodeChannelMessagePage(rawId, rows, meLower, tally);
        for (const [i, msg] of rows.entries()) {
          const decoded = decodedRows[i];
          if (!decoded) continue;
          // A reaction is a row of its own now (WP-40): it changes a bubble instead of being one.
          // Merged by the same last-write-wins rule everywhere, so the order the page is read in
          // cannot change the result - including a reaction read before the message it lands on.
          if (decoded.kind === 'reaction') {
            const r = decoded.reaction;
            applyChannelReactionFrame(r.targetMessageId, r.senderId, r.emoji, r.at, r.removed);
            continue;
          }
          // An edit is a row of its own as well: collected and applied once the page is built, so
          // it lands whatever order the rows came in.
          if (decoded.kind === 'edit') {
            edits.push(decoded.edit);
            continue;
          }

          // Seed the live poll tally from the server row, keyed by the server id.
          if (msg.poll) pollMetas.push([String(msg.id), msg.poll]);

          if (decoded.message.isOwn && decoded.message.clientMessageId) {
            clientIdOf.set(decoded.message.id, decoded.message.clientMessageId);
          }
          loaded.push({
            id: decoded.message.id,
            senderId: decoded.message.senderId,
            content: decoded.message.content,
            timestamp: decoded.message.timestamp,
            serverTimestamp: decoded.message.serverTimestamp,
            isOwn: decoded.message.isOwn,
            isSystem: decoded.message.isSystem,
          });
        }
      }

      tally.report();
      // ONCE per salon, from this load's own count: rows under a v1 session this device does not
      // hold are gone for good here (section 21.7), and a silent gap reads as a bug.
      const notice = olderMessagesNotice(
        channelConversationId,
        Array.isArray(rows) ? rows : [],
        tally.rowsOf(V1_SESSION_NOT_HELD)
      );
      if (notice) loaded.push(notice);
      loaded.sort(compareMessageOrder);
      const loadedEdited = applyChannelEdits(loaded, edits, ctx.log);

      if (!salonLoadGenerations.isLatest(channelConversationId, generation)) {
        ctx.log(
          `[CHANNEL] history load of ${channelConversationId} superseded by a newer one - its page is not merged`
        );
        return;
      }
      for (const [messageId, meta] of pollMetas) setPollMeta(messageId, meta);

      let current = conversations.get(channelConversationId);
      if (current) {
        // THIS DEVICE'S OWN ECHOES THE PAGE ALREADY HOLDS are re-keyed to the server's row first, so the
        // merge below sees ONE row. It is the proof that settles an echo whose POST reply was lost or
        // carried no id and whose frame never came (WP-OFF-2) - no clock involved. Only the author's
        // own rows can match: `isOwn` is the row's proven sender.
        let reKeyed = current.messages;
        for (const row of loadedEdited) {
          const clientId = clientIdOf.get(row.id);
          if (!row.isOwn || !clientId) continue;
          reKeyed =
            nextEchoMessages(reKeyed, clientId, { kind: 'settled', serverId: row.id }) ?? reKeyed;
        }
        if (reKeyed !== current.messages) {
          ctx.log(`[SALON-ECHO] history load settled echo(es) of ${channelConversationId}`);
          current = { ...current, messages: reKeyed };
        }
        // The page is the proof the server holds these: whatever the unsent ledger still keeps for
        // them (a POST reply lost, a previous page life killed mid-send) must not come back.
        if (clientIdOf.size > 0) clearUnsentSalonTexts(ctx.userId, clientIdOf.values());
        // Same race as the DM path, and worse: decrypting 200 channel rows takes seconds, and every
        // live message posted meanwhile used to be discarded when this resolved.
        // The reader's OWN mark comes from the server and the owed queue, never from a belief the
        // device restored: one held above the server's stops the receipt from ever being posted.
        const readWatermarks = salonMarksAfterLoad(
          current.readWatermarks,
          rawMarks === undefined ? undefined : (parseReadWatermarks(rawMarks) ?? {}),
          ctx.userId,
          owedSalonReadMarks(ctx.userId)[channelConversationId]?.at,
          channelConversationId
        );
        // EVERY ROW DRAWN FROM THE STORE THAT THIS PAGE DOES NOT NAME IS WITHDRAWN (F4, review
        // 2026-10-15). The copy is a preview of the server's newest page, and the server HARD-deletes
        // a salon message (no tombstone), so a missing row is the only sign it is gone. The merge
        // alone cannot say it: memory is authoritative outside a page's window, so a deleted newest
        // row reads as a live arrival and an emptied salon's page removes nothing. A drawn row older
        // than a full page is withdrawn too: what lies between it and the page is unknown, and a row
        // shown across a hidden gap is worse than one fetched again on scroll. Only rows drawn from
        // the store and not yet confirmed - by THIS load or by one it superseded (see
        // `salonRowsDrawnUnconfirmed`): a message that arrived live after the draw is in neither.
        let base = current.messages;
        // The server's rows alone: the older-messages notice is not a message, and is never stored.
        const serverRows = loadedEdited.filter(
          (m) => m.id !== olderMessagesNoticeId(channelConversationId)
        );
        const drawnUnconfirmed = salonRowsDrawnUnconfirmed.get(channelConversationId);
        salonRowsDrawnUnconfirmed.delete(channelConversationId);
        if (drawnUnconfirmed && drawnUnconfirmed.size > 0) {
          const inPage = new SvelteSet(serverRows.map((m) => m.id));
          const withdrawn = new SvelteSet([...drawnUnconfirmed].filter((id) => !inPage.has(id)));
          if (withdrawn.size > 0) {
            ctx.log(
              `[CHANNEL] ${channelConversationId.slice(0, 16)} ${withdrawn.size} stored row(s) the fresh page does not name withdrawn`
            );
            base = base.filter((m) => !withdrawn.has(m.id));
          }
        }
        conversations.set(channelConversationId, {
          ...current,
          // FIRST after the merge too: a reload can hold rows older than this page (section 21.7).
          messages: keepNoticeOnTop(mergeMessagePage(base, loadedEdited), channelConversationId),
          ...(readWatermarks !== undefined ? { readWatermarks } : {}),
        });
        channelHistoryLoadedAt.set(channelConversationId, {
          loadedAt: Date.now(),
          userId: ctx.userId,
        });
        await storeSalonPage(channelConversationId, serverRows, ctx);
      }
    } catch (e) {
      ctx.log(`[CHANNEL] History load failed: ${String(e)}`);
    } finally {
      if (salonLoadsInFlight.get(channelConversationId) === inFlight) {
        salonLoadsInFlight.delete(channelConversationId);
      }
      finishLoad();
      // The load that raised the skeleton last lowers it: a superseded load leaves it to a newer one
      // that raised it again, never to one that did not (see `salonSkeletonOwner`).
      if (salonSkeletonOwner === generation) {
        isLoadingHistory = false;
        salonSkeletonOwner = 0;
        skeletonSalon = null;
      }
    }
  }

  /**
   * Full-text search over a channel's ENTIRE history (channels keep only the most recent page in
   * memory and are never persisted locally). Pages the whole channel from the server, decrypts each
   * message, and matches the human-readable preview text. As a side effect it merges the fetched
   * history into the conversation so every hit is rendered and the UI can scroll to it. Returns the
   * matching message IDs oldest-first (the order ChatArea expects), capped at ~2000 messages.
   */
  async function searchChannelHistory(
    channelConversationId: string,
    query: string,
    ctx: ConversationContext
  ): Promise<string[]> {
    const q = foldForSearch(query.trim());
    if (q.length < 2) return [];

    const { channelService } = await import('$lib/services/ChannelService');
    const { decodeChannelMessagePage, UnreadableRowTally } =
      await import('$lib/utils/chat/channelCrypto');
    const { getPreviewText, parseEnvelope } = await import('$lib/envelope');
    const { keepNoticeOnTop } = await import('$lib/utils/chat/olderMessagesNotice');

    const rawId = channelConversationId.replace(/^channel_/, '');
    const meLower = ctx.userId.toLowerCase();

    const { rows, capped } = await channelService.fetchAllChannelMessages(channelConversationId, {
      cap: 2000,
    });

    const decodedPlain: ChatMessage[] = [];
    const searchEdits: DecodedChannelEdit[] = [];
    const tally = new UnreadableRowTally(rawId);
    const decodedRows = await decodeChannelMessagePage(rawId, rows, meLower, tally);
    for (const [i, row] of rows.entries()) {
      const decoded = decodedRows[i];
      if (!decoded) continue;
      if (decoded.kind === 'reaction') {
        // Searching the whole history is also the widest sweep of reaction frames there is, so it
        // merges them rather than dropping them - a search must not cost a message its hearts.
        const r = decoded.reaction;
        applyChannelReactionFrame(r.targetMessageId, r.senderId, r.emoji, r.at, r.removed);
        continue;
      }
      if (decoded.kind === 'edit') {
        searchEdits.push(decoded.edit);
        continue;
      }
      const message = decoded.message;
      if (row.poll) setPollMeta(String(row.id), row.poll);
      decodedPlain.push({
        id: message.id,
        senderId: message.senderId,
        content: message.content,
        timestamp: message.timestamp,
        isOwn: message.isOwn,
        isSystem: message.isSystem,
      });
    }
    // Edits first, THEN the match: a search must find the words a message holds now, not the ones
    // it was first sent with.
    const decodedAll = applyChannelEdits(decodedPlain, searchEdits, ctx.log);
    const matches: { id: string; ts: number }[] = [];
    for (const message of decodedAll) {
      let text = message.content;
      try {
        text = getPreviewText(parseEnvelope(message.content));
      } catch {
        /* fall back to the raw content */
      }
      if (foldForSearch(text).includes(q)) {
        matches.push({ id: message.id, ts: message.timestamp.getTime() });
      }
    }

    // Merge the full fetched history into the conversation (union by id, keeping optimistic/pending
    // local messages) so a hit older than the loaded page is present and scrollable.
    //
    // WRITTEN ONLY WHEN THE MERGE ACTUALLY ADDS SOMETHING. This used to `set` unconditionally, and a
    // `set` mints a new conversation object whether or not its contents changed - which made this
    // function retrigger whatever was watching the conversation, including the effect that had just
    // called it. Measured by the campaign's SEARCH-4 on 2026-08-22: one search in a 1052-message
    // channel issued 4956 requests to `/messages` and was still going ten minutes later, never
    // settling on a result, because every pass rewrote the object that caused the next pass.
    const current = conversations.get(channelConversationId);
    if (current) {
      const existingIds = new SvelteSet(current.messages.map((m) => m.id));
      const added = decodedAll.filter((m) => !existingIds.has(m.id));
      // EVERY ROW THIS SWEEP DECODED IS CONFIRMED BY THE SERVER, so it leaves the unconfirmed draws.
      // Otherwise a stored row it just merged stays pending past a failed load, and the next page,
      // whose window starts above it, would withdraw a message the server still holds.
      const pending = salonRowsDrawnUnconfirmed.get(channelConversationId);
      if (pending) for (const m of decodedAll) pending.delete(m.id);
      if (added.length) {
        // A whole-history sweep brings the oldest rows of all: the notice stays above them.
        const merged = keepNoticeOnTop(
          [...current.messages, ...added].sort(compareMessageOrder),
          channelConversationId
        );
        conversations.set(channelConversationId, { ...current, messages: merged });
      }
    }

    if (capped) {
      ctx.log(`[CHANNEL] Search covered the ${rows.length} most recent messages (history capped)`);
    }

    return matches.sort((a, b) => a.ts - b.ts).map((m) => m.id);
  }

  /**
   * One SESSION's restore chain: the restore running now, and the ONE restore queued behind it.
   * Plain fields, not `$state`: nothing renders them, they only order calls.
   *
   * A generation, because this composable is a global singleton that outlives a sign-out and a
   * chain must not. The sign-out retires it ({@link invalidateRestores}): a queued restore of a
   * retired generation never starts - it would recreate an MLS client with the previous account's
   * storage and key and refill the map the teardown just cleared - and a restore still running from
   * one blocks nothing, because the next session asks on a fresh generation.
   */
  interface RestoreGeneration {
    /** Numbered only so a log line can say which session a dropped ask belonged to. */
    readonly id: number;
    retired: boolean;
    running: Promise<void> | null;
    queued: Promise<void> | null;
    /** The context the queued restore will run with - the latest one asked, as a later ask supersedes. */
    queuedCtx: ConversationContext | null;
    /** How many asks the queued restore carries, reported once when it starts rather than per ask. */
    queuedAsks: number;
    /** Conversations whose archive replay a restore skipped on a link known down (`oweArchiveReplays`). */
    owedArchives: Set<string>;
    /** Unsubscribes the one reconnect listener that replays {@link owedArchives}; null when none is armed. */
    owedReconnectOff: (() => void) | null;
  }

  function newRestoreGeneration(id: number): RestoreGeneration {
    return {
      id,
      retired: false,
      running: null,
      queued: null,
      queuedCtx: null,
      queuedAsks: 0,
      // A `SvelteSet` only because the lint asks for one in a `.svelte.ts`; nothing renders it.
      owedArchives: new SvelteSet(),
      owedReconnectOff: null,
    };
  }

  /**
   * THE ARCHIVES A RESTORE SKIPPED ON A LINK KNOWN DOWN ARE REPLAYED ON THE NEXT RECONNECT, ONCE.
   *
   * The restore runs at boot and on a Welcome only, so a replay it skipped (`loadExistingConversations`,
   * `onArchiveReplaysSkipped`) would otherwise wait for the conversation's next OPEN - days on a
   * phone, against a mailbox that keeps 14. An EVENT, never a clock: `connectivity.onReconnect`
   * fires on `online` and when a request is answered after a transport failure; an edge that comes
   * while the server is still not proven (`isOffline`) leaves the listener armed for the next one.
   * Idempotent by the durable stream cursor: a conversation already replayed meanwhile (opened, or a
   * later restore) costs one `limit=1` probe. Bound to its generation: a sign-out drops it.
   */
  function oweArchiveReplays(
    gen: RestoreGeneration,
    ctx: ConversationContext,
    ids: string[]
  ): void {
    for (const id of ids) gen.owedArchives.add(id);
    if (gen.owedReconnectOff) return;
    gen.owedReconnectOff = connectivity.onReconnect(() => {
      if (connectivity.isOffline) return;
      gen.owedReconnectOff?.();
      gen.owedReconnectOff = null;
      const owed = [...gen.owedArchives];
      gen.owedArchives.clear();
      if (gen.retired || owed.length === 0) return;
      void replayOwedArchives(gen, ctx, owed);
    });
  }

  /** Replays each owed archive in turn - serialised, as the restore's own phase 2 is. */
  async function replayOwedArchives(
    gen: RestoreGeneration,
    ctx: ConversationContext,
    ids: string[]
  ): Promise<void> {
    ctx.log(`[CATCHUP] link back - replaying ${ids.length} archive(s) skipped while it was down`);
    for (const id of ids) {
      if (gen.retired) return;
      // Left since (a leave, a delete): nothing to replay into.
      if (!conversations.has(id)) continue;
      try {
        await loadHistoryForConversation(id, id, ctx);
      } catch (e) {
        // Every swallowed branch logs: this archive waits for the conversation's next open.
        ctx.log(`[CATCHUP] owed archive replay of ${id.slice(0, 8)} failed: ${String(e)}`);
      }
    }
  }

  let restoreGeneration = newRestoreGeneration(0);
  /** The client a lost-invitation re-planner is registered on, so the sign-out can remove it. */
  let replannerMls: IMlsService | null = null;

  /**
   * Retires the current session's restore chain - called by the sign-out teardown, next to the
   * clearing of the map. What it guarantees is in {@link RestoreGeneration}; the restore already
   * running cannot be interrupted, but its end no longer marks the map restored nor wakes the MLS
   * client it captured, and the next login's restore does not wait for it.
   */
  function invalidateRestores(): void {
    const retired = restoreGeneration;
    retired.retired = true;
    retired.owedReconnectOff?.();
    retired.owedReconnectOff = null;
    retired.owedArchives.clear();
    restoreGeneration = newRestoreGeneration(retired.id + 1);
    // The re-planner re-plans into THIS session's map: the next account must not inherit it. Its
    // entries stay in the leaving account's own record.
    replannerMls?.setOwedInvitationReplanner(null);
    replannerMls = null;
    // The map is cleared beside this call, so it is no longer "restored": the flag is the NEXT
    // session's to set, and a reader asking before then (the share-sheet suggestions, a deep-link
    // landing) must wait for that session's restore rather than trust the one that left.
    conversationsRestored = false;
    Log.i(
      'RESTORE',
      `generation ${retired.id} retired (running=${retired.running !== null}, queued asks=${retired.queuedAsks})`
    );
  }

  /**
   * Reads all saved conversations from IndexedDB, verifies MLS state consistency, and populates the
   * conversations map.
   *
   * ONE RESTORE AT A TIME, AND AT MOST ONE QUEUED BEHIND IT (performance audit 2026-10-12, finding
   * 8). Every Welcome for a group the map lacks asks for a whole restore - every stored
   * conversation read, `/groups` asked, every history replayed - so a new device joining 80 groups
   * in one drain restored 80 times, the restores overlapping on the one WASM client their phase 2
   * is serialised for. An ask while a restore runs cannot join it: that run read the store before
   * the asker saved its row. So it is queued as the run AFTER it, and every further ask while that
   * one waits is folded into it - its caller awaits the same run, which starts after their rows
   * were saved and therefore reads them. A burst of N asks costs at most two restores, decided by
   * the order of the calls and nothing else.
   *
   * Every caller folded into the queued restore receives THE SAME promise, so a failure reaches
   * each of them as one rejection - which is what lets a caller report it once
   * (`reportRejectionOnce`). A chain belongs to one session: see {@link RestoreGeneration}.
   */
  function loadAndRestoreConversations(ctx: ConversationContext): Promise<void> {
    const gen = restoreGeneration;
    if (!gen.running && !gen.queued) return startRestore(gen, ctx);
    gen.queuedCtx = ctx;
    gen.queuedAsks++;
    // Folded silently: the queued restore names how many asks it carries when it starts, one line
    // per burst instead of one per Welcome.
    if (gen.queued) return gen.queued;
    const running = gen.running as Promise<void>;
    // The running restore's failure is delivered to ITS callers; the queued one runs either way,
    // because the asks it carries were made after that run read the store.
    gen.queued = running
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        const next = gen.queuedCtx as ConversationContext;
        const asks = gen.queuedAsks;
        gen.queued = null;
        gen.queuedCtx = null;
        gen.queuedAsks = 0;
        if (gen.retired) {
          // The session that asked has ended: running it would act as that account on the next
          // one's map. Its callers resolve - there is nothing left for them to wait for.
          next.log(
            `[RESTORE] ${asks} queued ask(s) dropped - generation ${gen.id} ended before they ran`
          );
          return;
        }
        next.log(`[RESTORE] one restore for ${asks} ask(s) made while the previous one ran`);
        return startRestore(gen, next);
      });
    return gen.queued;
  }

  /** Starts one restore and marks it running in its generation until it settles. */
  function startRestore(gen: RestoreGeneration, ctx: ConversationContext): Promise<void> {
    const run = restoreOnce(gen, ctx).finally(() => {
      if (gen.running === run) gen.running = null;
    });
    gen.running = run;
    return run;
  }

  /** One restore pass - see {@link loadAndRestoreConversations} for why passes never overlap. */
  async function restoreOnce(gen: RestoreGeneration, ctx: ConversationContext) {
    if (!ctx.storage) return;
    // The restore supersedes any local preview: from here the map is the session's.
    landingPreviewKey = null;
    landingPreviewOwner = null;
    // THE CLIENT THIS PASS RESTORED INTO, named once: asking `ensureMls()` again at the end would
    // CREATE a client if a sign-out retired this one meanwhile.
    let mlsService: IMlsService | null = null;
    let restored = false;
    try {
      mlsService = ctx.ensureMls();
      await loadExistingConversations({
        // The landing target stays pending while it is displayed, so this keeps the thread on
        // screen through the rebuild - see `preserveMessagesOf`.
        preserveMessagesOf: notifNav.pending,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        storage: ctx.storage,
        mlsService,
        conversations,
        messageReactions: ctx.messageReactions,
        archivedConversationIds: [],
        historyBaseUrl: ctx.historyBaseUrl,
        log: ctx.log,
        onArchivedIdsChange: () => {},
        onArchiveReplaysSkipped: (ids) => oweArchiveReplays(gen, ctx, ids),
      });
      restored = true;
    } finally {
      // A pass whose session ended speaks for nobody: the map is the next session's to mark, and
      // the client it would wake belongs to the account that left.
      if (!gen.retired) {
        conversationsRestored = true;
        // A frame that reached the handler while this map was still empty was left in the server
        // queue rather than dropped. The restore finishing is what makes it readable, so it is the
        // trigger to ask again - there is no timer waiting to notice.
        mlsService?.notifyConversationsRestored();
        // The re-plan of a lost invitation needs the map it re-plans into: registered only once a
        // restore SUCCEEDED - on a map a failed restore left empty, every entry would read as a
        // conversation that does not exist.
        if (mlsService && restored) {
          mlsService.setOwedInvitationReplanner(
            lostInvitationReplanner(ctx, mlsService, gen),
            makeUnrecordedInvitationTeller({ conversations, report: reportLostInvitation })
          );
          replannerMls = mlsService;
        }
      }
    }
  }

  /**
   * Draws the pending landing target from the LOCAL store, before the session is up (F1).
   *
   * Called by the login the moment it holds both the device key and the open store - on the vault
   * path that is BEFORE the token refresh and the revocation answer, which the user decided to
   * allow (2026-10-12) on the condition that a refused login removes everything drawn
   * ({@link discardLandingPreview}). It reads, it never sends or writes: see `landingPreview.ts`.
   *
   * It only ever ADDS a row the map does not hold: a warm session, or a restore that already ran,
   * owns the row and is left alone. And it marks the row as a preview only while no session owns
   * the map - `isSessionUp` is read after the read, because the read is what took time.
   */
  async function previewLandingTarget(input: {
    storage: IStorage;
    deviceKeyB64: string;
    userId: string;
    messageReactions: SvelteMap<string, MessageReaction[]>;
    isSessionUp: () => boolean;
    log: (msg: string) => void;
    /** Reported on the drawn line, beside the read's own duration: the two costs of the preview. */
    storeOpenMs?: number;
    /** The login drawing it - the only one whose discard may remove it. */
    owner?: number;
    /**
     * False once the login that asked has given up (failed, expired, revoked). Read AFTER the store
     * read, so a withdrawal never has to wait for a read in flight: the read lands on nothing.
     */
    isCurrent?: () => boolean;
  }): Promise<void> {
    const targetId = notifNav.pending;
    if (!targetId) return;
    if (conversations.has(targetId)) return;
    const readStart = performance.now();
    const preview = await readLandingPreview({
      storage: input.storage,
      deviceKeyB64: input.deviceKeyB64,
      userId: input.userId,
      targetId,
    });
    if (typeof preview === 'string') {
      input.log(`[LANDING_PREVIEW] nothing drawn for ${targetId.slice(0, 8)} (${preview})`);
      return;
    }
    // The landing may have been left, or another source may have written the row, while the store
    // was being read: either way the row is no longer this preview's to add.
    if (notifNav.pending !== targetId || conversations.has(targetId)) {
      input.log(`[LANDING_PREVIEW] ${targetId.slice(0, 8)} superseded during the read - not drawn`);
      return;
    }
    if (input.isCurrent && !input.isCurrent()) {
      input.log(
        `[LANDING_PREVIEW] ${targetId.slice(0, 8)} not drawn: the login that asked was withdrawn during the read`
      );
      return;
    }
    conversations.set(targetId, preview.row);
    for (const m of preview.row.messages) {
      if (m.reactions && m.reactions.length > 0) input.messageReactions.set(m.id, m.reactions);
    }
    const sessionUp = input.isSessionUp();
    if (!sessionUp) {
      landingPreviewKey = targetId;
      landingPreviewOwner = input.owner ?? null;
    }
    input.log(
      `[LANDING_PREVIEW] ${targetId.slice(0, 8)} drawn from the local store ` +
        `(${preview.messageCount} message(s); store open ${input.storeOpenMs ?? '?'} ms, ` +
        `read ${Math.round(performance.now() - readStart)} ms) ${sessionUp ? 'after' : 'before'} ` +
        'the session is up'
    );
  }

  /**
   * Selects the previewed target WITHOUT any of a selection's side effects (F1).
   *
   * No read mark, no member load, no history request: each of those acts on the server, and the
   * session that would carry them does not exist yet. The overlay entry IS pushed - the Back press
   * must behave as it will once the session is up, and the landing only calls this once the router
   * has reached the target's page (`landingStep`), the same precondition the real selection has.
   * When the session comes up the landing runs the real selection over it ({@link endLandingPreview}).
   */
  function previewSelect(key: string) {
    if (landingPreviewKey !== key) return;
    selectedContact = key;
    ensureMobileConvoHistory();
  }

  /** The session is up and now owns the previewed row: it stays, and stops being a preview. */
  function endLandingPreview() {
    landingPreviewKey = null;
    landingPreviewOwner = null;
  }

  /**
   * Removes everything the local preview drew (F1): the login failed, the device was revoked, or
   * the reader left the landing before the session came up. The row was put in the map by the
   * preview alone, so removing it restores the pre-session state exactly. Synchronous on purpose: a
   * failing login calls it before it releases the login flag, and must never wait on a store.
   *
   * `owner` names the login asking; a preview drawn by ANOTHER login is left alone. Omitted, the
   * discard is the landing's own (the reader left it) and applies whoever drew the row.
   */
  function discardLandingPreview(
    reason: string,
    messageReactions: SvelteMap<string, MessageReaction[]>,
    log: (msg: string) => void,
    owner?: number
  ) {
    const key = landingPreviewKey;
    if (key === null) return;
    if (owner !== undefined && owner !== landingPreviewOwner) {
      log(
        `[LANDING_PREVIEW] ${key.slice(0, 8)} kept: drawn by another login than the one ending (${reason})`
      );
      return;
    }
    landingPreviewKey = null;
    landingPreviewOwner = null;
    const row = conversations.get(key);
    for (const m of row?.messages ?? []) messageReactions.delete(m.id);
    conversations.delete(key);
    if (selectedContact === key) {
      if (mobileConvoHistoryClose) {
        const ref = mobileConvoHistoryClose;
        mobileConvoHistoryClose = null;
        abandonHistoryOverlay(ref);
      }
      selectedContact = null;
    }
    log(`[LANDING_PREVIEW] ${key.slice(0, 8)} removed from screen: ${reason}`);
  }

  /**
   * Load a page of older messages from local DB and prepend them to the conversation.
   * Returns true if there may be more, false if the DB is exhausted.
   */
  async function loadOlderMessages(
    contactName: string,
    ctx: ConversationContext
  ): Promise<boolean> {
    if (isChannelConversationId(contactName)) return false;
    if (!ctx.storage) return false;
    const convo = conversations.get(contactName);
    if (!convo) return false;

    const timestamps = convo.messages.map((m) =>
      m.timestamp instanceof Date
        ? m.timestamp.getTime()
        : new SvelteDate(m.timestamp as any).getTime()
    );
    const beforeTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : undefined;

    const older = await ctx.storage.getMessagesPage(
      convo.id,
      ctx.deviceKeyB64,
      OLDER_MESSAGES_PAGE,
      beforeTimestamp
    );
    if (older.length === 0) return false;

    const mapped = await retroactivelyResolveHexIds(
      mapStoredMessagesToChatMessages(older, ctx.userId),
      ctx.storage ?? null,
      convo.id,
      ctx.deviceKeyB64
    );

    const current = conversations.get(contactName);
    if (!current) return false;

    const existingIds = new SvelteSet(current.messages.map((m) => m.id));
    const merged = [...mapped.filter((m) => !existingIds.has(m.id)), ...current.messages].sort(
      compareMessageOrder
    );

    conversations.set(contactName, { ...current, messages: merged });
    return older.length === OLDER_MESSAGES_PAGE;
  }

  /**
   * Asks a peer for the page BELOW what this device holds, once the local store is exhausted.
   *
   * The scrollback. It exists because the device window is finite - ninety days on the web - so a
   * browser that never received the older past has no way to obtain it except from a member that
   * did. Same election and same rendezvous as the reconciliation, different boundary: this one is
   * driven by a reader scrolling, not by a connection.
   *
   * Bounded by construction: it asks for the page immediately before the oldest message it holds,
   * and the reader asks again by scrolling further. A conversation of any size is paged the same way.
   *
   * @returns `asked` when a peer was elected and the ask went out - the messages arrive later, as an
   *          ordinary bundle; `no-peer` when nobody was online to answer, which is the one outcome
   *          worth telling the reader about; `complete` when this conversation has no past to ask
   *          for; `unavailable` when this device cannot ask at all.
   */
  async function requestOlderFromPeers(
    contactName: string,
    ctx: ConversationContext
  ): Promise<'asked' | 'no-peer' | 'complete' | 'unavailable'> {
    if (isChannelConversationId(contactName)) return 'unavailable';
    const convo = conversations.get(contactName);
    if (!convo || !ctx.storage) return 'unavailable';

    const timestamps = convo.messages
      .map((m) =>
        m.timestamp instanceof Date
          ? m.timestamp.getTime()
          : new SvelteDate(m.timestamp as any).getTime()
      )
      .filter((t) => Number.isFinite(t));
    // Nothing held means nothing to ask BEFORE. That case is the reconciliation's, not this one's:
    // an empty conversation is repaired by the state key comparison on connect.
    if (timestamps.length === 0) return 'unavailable';
    const before = Math.min(...timestamps);

    const since = await historyRangeStartFor(convo.id, ctx.storage);

    // NOTHING IS ASKED FOR A PAST THAT CANNOT EXIST, and this is the one fact that settles it.
    //
    // The scrollback reaches BELOW this device's retention window by asking a member who kept more.
    // A group created INSIDE that window has nothing below it: everything it ever held is inside
    // the range this device claims completeness for, which is the RECONCILIATION's range, not this
    // one's. The messages alone cannot say so - the oldest message held is always strictly after
    // the group was created - so a first contact was indistinguishable from a device missing years
    // of history. It asked, the only other member was the person who had just written and was no
    // longer online, and the reader's first sight of a new correspondent was a notice that no
    // device could supply older messages. The user reported exactly that, and it was reproduced on
    // an Android handset on 2026-09-21 on a group two minutes old.
    //
    // `complete` RATHER THAN `unavailable`, though both draw nothing today: one says there is
    // nothing to fetch, the other says this device cannot fetch. Collapsing them would put the next
    // reader back where this defect started, with one value standing for two situations.
    if (convo.startedAt !== undefined && convo.startedAt >= since) {
      ctx.log(
        `[HISTORY_RANGE] ${convo.id.slice(0, 8)}… began inside this device's window - nothing older exists`
      );
      return 'complete';
    }

    if (before <= since) {
      // We already hold everything down to the floor of our own window. There is nothing below it
      // that anybody is entitled to send us.
      ctx.log(`[HISTORY_RANGE] ${convo.id.slice(0, 8)}… already reaches its floor - not asking`);
      return 'unavailable';
    }

    const mls = ctx.ensureMls();
    let outcome;
    try {
      outcome = await mls.sendHistoryRequest(convo.id);
    } catch (e) {
      ctx.log(`[HISTORY_RANGE] could not reach the service: ${String(e).slice(0, 120)}`);
      return 'no-peer';
    }
    if (outcome?.noPeerOnline) return 'no-peer';

    const sent = await sendHistoryRangeRequest(
      convo.id,
      {
        from: digestIdentity(ctx.userId, mls.getDeviceId()),
        before,
        limit: SCROLLBACK_PAGE,
        since,
      },
      { mlsService: mls, log: ctx.log }
    );
    return sent ? 'asked' : 'unavailable';
  }

  // ── Selection + navigation ────────────────────────────────────────────────

  function dismissSidePanelIfAny() {
    if (!sidePanelHistoryClose) {
      sidePanel = null;
      return;
    }
    const ref = sidePanelHistoryClose;
    sidePanelHistoryClose = null;
    sidePanel = null;
    abandonHistoryOverlay(ref);
  }

  /** Selects a conversation (sets selectedContact, clears unread badge and send error). Use this version when no ctx is available (e.g. from channel event handlers). */
  function dismissDrawerHistoryIfAny() {
    if (!drawerHistoryClose) return;
    const ref = drawerHistoryClose;
    drawerHistoryClose = null;
    isConversationDrawerOpen = false;
    abandonHistoryOverlay(ref);
  }

  /**
   * Ends a deep-link landing as soon as the user opens something else, so its target stops being
   * protected from the selection watchdog. The landing itself selects its own target, so a call
   * naming that target is the landing at work and must not cancel it.
   *
   * "Naming that target" is a comparison of a MAP KEY against a pending GROUP ID, and those differ
   * for every DM - so the raw string check ended the landing on the landing's own call. The target
   * then lost its protection immediately and the IndexedDB restore dropped the selection moments
   * later: the tap arrived on the right tab, on no conversation. Resolve before comparing.
   */
  function endLandingUnlessTarget(name: string | null) {
    const pending = notifNav.pending;
    if (!pending || pending === name) return;
    if (resolveConversationKey(conversations, pending) === name) return;
    notifNav.clear();
  }

  function selectConversation(name: string) {
    endLandingUnlessTarget(name);
    dismissDrawerHistoryIfAny();
    dismissSidePanelIfAny();
    selectedContact = name;
    noteSalonOpened(name);
    sendError = '';
    const convo = conversations.get(name);
    if (convo) {
      conversations.set(name, { ...convo, unreadCount: 0 });
      publishConversationRead(name, convo.lastMessageAt ?? 0);
    }
    if (convo?.id) {
      void loadGroupMembers(convo.id, null);
    }
    ensureMobileConvoHistory();
  }

  /** Call this version when you have the ctx available (inside handlers). */
  function selectConversationWithCtx(name: string, ctx: ConversationContext) {
    endLandingUnlessTarget(name);
    dismissDrawerHistoryIfAny();
    dismissSidePanelIfAny();
    selectedContact = name;
    noteSalonOpened(name);
    sendError = '';
    const convo = conversations.get(name);
    if (convo) {
      conversations.set(name, { ...convo, unreadCount: 0 });
      publishConversationRead(name, convo.lastMessageAt ?? 0);
    }
    if (convo?.id) {
      void loadGroupMembers(convo.id, ctx);
      void verifyCurrentUserMembership(name, ctx);
    }
    ensureMobileConvoHistory();
  }

  /** Deselects the active conversation and closes the drawer (mobile back-button action). */
  function goBackToMenu() {
    dismissSidePanelIfAny();
    // Cleared synchronously so any rapid click on a new conversation after pressing back pushes a
    // fresh history overlay rather than reusing the stale one.
    leaveThread();
    if (mobileConvoHistoryClose) {
      // abandonHistoryOverlay takes the entry off the stack without calling its close, so the old
      // callback can never clear a newly-selected conversation; the entry stays as a ghost.
      const ref = mobileConvoHistoryClose;
      mobileConvoHistoryClose = null;
      abandonHistoryOverlay(ref);
    }
  }

  function openConversationDrawer() {
    isConversationDrawerOpen = true;
    ensureDrawerHistory();
  }

  function closeConversationDrawer() {
    if (drawerHistoryClose) {
      closeHistoryOverlayFromUi(drawerHistoryClose);
      return;
    }
    isConversationDrawerOpen = false;
  }

  /**
   * Shows one side panel, replacing whatever was open.
   *
   * SWITCHING PANELS UNWINDS THE OLD HISTORY ENTRY FIRST. Pushing a second overlay entry for a
   * panel that is being replaced rather than stacked would make the phone's back gesture need two
   * presses to leave one visible panel, and the second press would close a panel that was never
   * on screen.
   */
  function openSidePanel(kind: ConversationSidePanelKind) {
    if (sidePanel === kind) return;
    if (sidePanel && sidePanelHistoryClose) dismissSidePanelIfAny();
    sidePanel = kind;
    ensureSidePanelHistory();
  }

  function closeSidePanel() {
    if (sidePanelHistoryClose) {
      closeHistoryOverlayFromUi(sidePanelHistoryClose);
      return;
    }
    sidePanel = null;
  }

  /** Opens a panel, or closes it if it is the one already showing. */
  function toggleSidePanel(kind: ConversationSidePanelKind) {
    if (sidePanel === kind) closeSidePanel();
    else openSidePanel(kind);
  }

  // ── Group members ─────────────────────────────────────────────────────────

  /**
   * Reads the group's roster ({@link fetchGroupRoster}) into groupMembers, the ONE list every
   * member surface shows. No-op for channel conversations, and for one this device is no longer in.
   * Re-read on the events that change it: selecting the conversation, and the end of this device's
   * own Add, admission or Remove (each writes the roster before it returns).
   *
   * THE ROSTER OF A RETIRED CONVERSATION IS NOT OURS TO ASK FOR. `GET /api/mls/groups/:id/user-members`
   * (like `.../members`, which this read used until 2026-10-25) is members-only by design, so on a device holding a Remove commit the request has exactly one
   * possible outcome, and it is a 403 in the console of every removed device. Both selection paths
   * fire this one line above `verifyCurrentUserMembership`, which was taught the same fact on
   * 2026-08-23 - this call site was not, which is why GRP-3 still recorded the 403 the next day.
   * The discriminator is durable, local and already in the row (see `membershipIsDurablyLost`).
   *
   * An empty roster is the ANSWER here rather than a fallback: there is no membership to show.
   */
  async function loadGroupMembers(
    id: string,
    ctx: ConversationContext | null,
    opts?: { fresh?: boolean }
  ) {
    if (!ctx) return;
    if (isChannelConversationId(id)) {
      groupMembers = [];
      return;
    }
    const key = findConversationKeyByGroupId(conversations, id);
    if (membershipIsDurablyLost(key ? conversations.get(key) : undefined)) {
      groupMembers = [];
      ctx.log(`[VERIFY] Roster of ${id.slice(0, 8)}… not requested - conversation retired`);
      return;
    }
    try {
      groupMembers = await fetchGroupRoster(ctx.ensureMls(), id, opts);
    } catch (e) {
      console.warn('[GroupMembers]', e);
      groupMembers = [];
    }
  }

  /** Remembers a membership verdict for 30 s, so a re-selected conversation does not re-ask. */
  function cacheMembership(groupId: string, isMember: boolean) {
    membershipCache.set(groupId, { isMember, expiresAt: Date.now() + 30_000 });
  }

  /**
   * Records the eviction and surfaces it, then answers `false`.
   *
   * Extracted so the LOCAL verdict and the SERVER verdict share one presentation: they are the same
   * conclusion reached from two places, and a second copy of the notice logic is a second chance for
   * them to disagree about what the user sees.
   *
   * IT WROTE NOTHING DOWN, AND THAT WAS THE DEFECT. This is the most user-visible of the five
   * places an eviction is learnt - it runs on every conversation selection - and it was the only
   * one that recorded the fact nowhere: a notice in the thread, `sendError` on the composer, and a
   * thirty-second entry in `membershipCache`, all of which die with the page. The row stayed
   * `active`, so the next load asked the members-only endpoint for its roster again, the re-add
   * guards did not know to stand down, and the fact had to be re-learnt on the next selection, for
   * ever. {@link recordEviction} writes `lifecycle: 'removed'` durably, which is what every one of
   * those readers is already looking at.
   *
   * `sendError` stays here: it is the composer's live state, not a fact about the group.
   */
  async function surfaceRemoval(
    contactName: string,
    convo: Conversation,
    evidence: EvictionEvidence,
    ctx: ConversationContext
  ): Promise<false> {
    console.warn(`[VERIFY] User no longer member of ${convo.id} - showing removal notice`);
    await recordEviction({
      conversations,
      groupId: convo.id,
      evidence,
      saveConversation: (key) => saveConversation(key, ctx),
      addMessageToChat: ctx.addMessageToChat,
      log: ctx.log,
    });
    if (selectedContact === contactName) sendError = chat_system_removed_from_group();
    return false;
  }

  /**
   * Checks whether the current user is still a member of the given conversation. Caches the result
   * for 30 s. Attempts server re-registration and direct-conversation repair before surfacing a
   * removal notice.
   *
   * THE LOCAL MLS STATE IS ASKED FIRST, AND ON `false` IT IS THE WHOLE ANSWER. A Remove commit is a
   * signed, ordered statement by a member entitled to make it, already applied and already durable
   * (see `eviction.ts`) - so a device that has one has nothing left to ask anybody. Asking anyway
   * sent `GET /api/mls/groups/:id/members` to an endpoint that is members-only BY DESIGN, which is
   * to say: on the one question worth asking, the request could only ever be refused. That is a
   * 403 in the console of every removed device, and it is learning by failing what a fact already
   * told us. GRP-3 caught it on 2026-08-23.
   *
   * The two paths overlapped rather than disagreed, which is why nothing failed: the eviction was
   * ALSO learnt from the commit, and `convo.lifecycle` carried it. This deletes the overlap instead
   * of reconciling it - the local fact decides, and the server is asked only about what the local
   * state cannot see, which is server-side drift while we ARE still a member.
   */
  async function verifyCurrentUserMembership(
    contactName: string,
    ctx: ConversationContext
  ): Promise<boolean> {
    const convo = conversations.get(contactName);
    if (!convo) return false;
    if (isChannelConversationId(convo.id)) return true;

    const cached = membershipCache.get(convo.id);
    if (cached && cached.expiresAt > Date.now()) return cached.isMember;

    const mlsService = ctx.ensureMls();
    const localMembership = await readLocalMembership({
      mlsService,
      groupId: convo.id,
      context: 'before verifying against the server',
      log: ctx.log,
    });
    // Only `false` short-circuits. `null` means the local state could not say - a conversation whose
    // MLS group this device does not hold - and that is exactly the case the server can still answer.
    if (localMembership === false) {
      cacheMembership(convo.id, false);
      return await surfaceRemoval(contactName, convo, 'membership-check', ctx);
    }

    try {
      const members = await fetchUniqueGroupMembers(mlsService, convo.id);
      if (members.length === 0) {
        cacheMembership(convo.id, true);
        return true;
      }
      const stillMember = members.some((m) => m.toLowerCase() === ctx.userId.toLowerCase());
      if (stillMember) {
        cacheMembership(convo.id, true);
        return true;
      }

      // Self-heal transient server drift first: re-register this device in the
      // gateway membership set, then re-check before attempting any heavy repair.
      try {
        await mlsService.registerMember(convo.id, ctx.userId);
        const repairedMembers = await fetchUniqueGroupMembers(mlsService, convo.id);
        const backInGroup = repairedMembers.some(
          (m) => m.toLowerCase() === ctx.userId.toLowerCase()
        );
        if (backInGroup) {
          ctx.log(`[SYNC] Server re-registration succeeded for ${convo.id}.`);
          cacheMembership(convo.id, true);
          return true;
        }
      } catch (e) {
        // Non-blocking - the repair below is what answers. But a swallowed branch logs: this is
        // where a re-registration that never works would sit silently for ever.
        ctx.log(`[SYNC] Server re-registration of ${convo.id.slice(0, 8)}… failed: ${String(e)}`);
      }

      if (convo.conversationType === 'direct') {
        const localGroups = new SvelteSet(mlsService.getLocalGroups());
        if (localGroups.has(convo.id)) {
          // We still have valid local MLS state: avoid destructive auto-repair
          // (new group creation) and keep operating while sync converges.
          ctx.log(
            `[WARN] Server membership missing for ${convo.id}, heavy repair skipped (local MLS state present).`
          );
          console.warn(
            `[VERIFY] Server membership missing for ${convo.id} but local MLS state present - skipping repair`
          );
          return true;
        }

        try {
          // `convo.id`, not `contactName`: this function is reached through the map KEY, and for a
          // direct conversation learnt from a Welcome that key is the peer's user id. `requestReAdd`
          // is addressed by GROUP id - the same distinction `localGroups.has(convo.id)` two lines
          // above already makes.
          await requestReAdd(convo.id, {
            mlsService,
            storage: ctx.storage,
            userId: ctx.userId,
            deviceKey: () => ctx.deviceKeyB64,
            conversations,
            getSelectedContact: () => selectedContact,
            setSelectedContact: (id: string | null) => {
              if (id) selectConversationWithCtx(id, ctx);
            },
            saveConversation: (name: string) => saveConversation(name, ctx),
            log: ctx.log,
          });
          console.log(`[VERIFY] Direct conversation ${convo.id} recovery triggered`);
          return true;
        } catch {
          // Recovery failed - fall through to show removal notice
        }
      }
      return await surfaceRemoval(contactName, convo, 'server-refusal', ctx);
    } catch (e) {
      // A STATUS CODE IS AN ANSWER, A TRANSPORT FAILURE IS NOT - and this `catch` used to make no
      // such distinction: it answered `true` to everything, so the server saying "you are not a
      // member" in the clearest way it has was read as "still a member". It failed in the unsafe
      // direction, on the exact input it was most likely to see.
      if (e instanceof NotAGroupMemberError) {
        cacheMembership(convo.id, false);
        return await surfaceRemoval(contactName, convo, 'server-refusal', ctx);
      }
      // Anything else - unreachable, 5xx, a refused token - says NOTHING about membership, so it
      // must not retire a conversation. `true` keeps the client working; the log is what stops the
      // branch from being silent, since this is where a real outage would hide.
      ctx.log(`[VERIFY] Membership of ${convo.id.slice(0, 8)}… could not be checked: ${String(e)}`);
      return true;
    }
  }

  // ── Group operations ──────────────────────────────────────────────────────

  /**
   * Shared cleanup for delete and leave: records the departure locally, calls an optional server
   * action, then purges the local MLS + UI state regardless of whether the server call succeeds.
   *
   * THE DEPARTURE IS RECORDED BEFORE IT IS ACTED ON, AND THAT ORDERING IS THE POINT. The row used
   * to be purged at the very END, so for the whole span of the server action, the WASM forget and
   * the state persist that follow it - hundreds of milliseconds to seconds - a conversation this
   * device had irrevocably given up still looked exactly like a live one. `loadGroupMembers` is
   * fired by a `$effect` over the conversations map, so ANY write inside that span - the
   * `memberLeft` system message this very path adds - re-ran it against a group whose server-side
   * membership had just been revoked, and asked a members-only endpoint the one question it is
   * certain to refuse. That is a `GET /api/mls/groups/:id/members -> 403` in the leaver's console,
   * intermittent by nature, and GRP-6 recorded it on 2026-08-24.
   *
   * A guard on the asker would have been the THIRD door patched on this one endpoint (audit S5,
   * `membershipIsDurablyLost`), so this closes the seam instead: `lifecycle: 'removed'` is the
   * durable local statement "this device is out", every reader of it already behaves correctly on
   * that answer - no roster, no send, no recovery - and the purge below then removes the row. The
   * only overlap there ever was is the window where the row disagreed with the decision, and it is
   * gone rather than reconciled.
   *
   * A crash inside the window is IMPROVED by this, not risked: it now leaves a row the UI can
   * explain and the user can clear in one click, where before it left a live-looking conversation
   * with no MLS state behind it - unusable, and refused by the server on every selection.
   *
   * The UI reset moves up for the same reason and one more: the "removed" banner offers a
   * delete-locally button, and it must not appear under a conversation the user is already leaving.
   *
   * AND THE SERVER CALL IS WRITTEN DOWN BEFORE IT IS MADE, for the same class of reason one rung
   * further out. Retiring first closed the window where the LOCAL row disagreed with the decision;
   * `recordPendingGroupExit` closes the window where the SERVER does. DEL-10 caught the second on
   * 2026-08-24: with the link cut, the delete was attempted, the failure was caught and logged, and
   * the purge ran anyway - so the group survived on the server with no client able to open it, and
   * `discoverMissingGroups` handed it back as a placeholder. The decision now outlives the failed
   * attempt, and {@link drainPendingGroupExits} completes it on the next reconnect.
   *
   * `exitKind` is PASSED, never inferred from `label`: the drain has to make the same call the
   * caller meant, and a verb read back out of a display string is a verb one edit away from wrong.
   */
  async function exitGroupAndCleanup(
    contactKey: string,
    convo: Conversation,
    serverAction: (mlsService: IMlsService) => Promise<void>,
    label: string,
    exitKind: 'delete' | 'leave',
    ctx: ConversationContext
  ) {
    const mlsService = ctx.ensureMls();
    // THE OWED READ MARK GOES FIRST, AND SYNCHRONOUSLY. Dropping the selection below ends the open
    // conversation's read debounce, whose cleanup hands every OWED mark to the outbox - and a mark of
    // this group, queued there, is a frame the server refuses with 403 once the membership ends
    // (GRP-6, 2026-10-22). Revoked here, before any await, the ledger no longer names the group when
    // that cleanup runs, and nothing re-enqueues it at the next sign-in; the outbox's exit drain below
    // settles what was already queued, and the owed exit makes the outbox refuse any later mark.
    forgetDmReadMark(ctx.userId, convo.id);
    if (contactKey !== convo.id) forgetDmReadMark(ctx.userId, contactKey);
    await retireConversation({
      conversations,
      key: contactKey,
      groupId: convo.id,
      saveConversation: (key) => saveConversation(key, ctx),
    });
    membershipCache.delete(convo.id);
    selectedContact = null;
    isConversationDrawerOpen = false;
    sendError = '';
    groupMembers = [];
    ctx.log(`[${label}] ${convo.id.slice(0, 8)}… retired locally before the server action`);
    // THE SERVER CALL IS OWED BEFORE IT IS ATTEMPTED, and that row is what DEL-10 was missing. The
    // purge below is unconditional by design - the user has left, and a conversation they cannot
    // leave because the network is down would be worse than any of this - but before this row the
    // purge was also the END of the story: a delete that never reached the server left the group
    // standing, the MLS state destroyed, and `discoverMissingGroups` handing the group back.
    // See `pendingGroupExits` for the whole reasoning; the drain replays this on reconnect.
    await recordPendingGroupExit(ctx.storage, convo.id, exitKind, ctx.log);
    // NOTHING OF THIS GROUP MAY STILL BE QUEUED OR ON THE WIRE WHEN THE SERVER ENDS THE MEMBERSHIP:
    // every such frame is refused 403 by then and parked until the next sign-in, for a group this
    // device no longer holds. The outbox therefore SETTLES the group first - it awaits a send in
    // flight, sends what still can go (the membership and the MLS state exist until the server step,
    // so a text written just before leaving arrives), and withdraws only what cannot, logging it by
    // kind. The owed exit recorded just above is what makes every later enqueue for the group refuse
    // itself, and every ordinary flush withdraw the group's rows - so a kill before this drain leaves
    // nothing that the relaunch's replay of the exit could race into a 403. The leave's own `memberLeft` notice is not in the outbox: it is a direct send whose
    // acceptance `leaveGroupAndBroadcast` awaits.
    await drainOutboxForExit(convo.id, exitKind).catch((e: unknown) =>
      ctx.log(
        `[${label}] outbox of ${convo.id.slice(0, 8)}… NOT settled before the server step - any entry left will be refused once the membership ends: ${String(e)}`
      )
    );
    try {
      const onServer = await isGroupActiveOnServer(mlsService, ctx.userId, convo.id);
      if (onServer !== false) {
        await serverAction(mlsService);
      } else {
        ctx.log(`[${label}] Groupe ${convo.id} absent du serveur - purge MLS/UI locale`);
      }
      // MANUAL delete/leave: record the per-user dismiss so the conversation also disappears from
      // the user's OTHER devices (rules 3 & 5) - their discovery purges it instead of showing the
      // "deleted" banner (reserved for peer deletions / exclusions). Best-effort: the local purge
      // below happens either way.
      await mlsService.dismissGroup(convo.id).catch((e: unknown) => {
        ctx.log(
          `[${label}] dismissGroup(${convo.id}) failed - other devices keep it: ${String(e)}`
        );
      });
      // ANSWERED - the group is gone, or was never there. Either way nothing is owed.
      await clearPendingGroupExit(ctx.storage, convo.id, ctx.log);
    } catch (e) {
      // TWO OUTCOMES WEARING ONE CATCH UNTIL NOW, and they are not the same fact. A status is the
      // server ANSWERING; a transport failure is the absence of an answer, and only the second
      // leaves something owed. `isGroupActiveOnServer` returns `null` rather than throwing on a
      // failed probe, so what lands here is the serverAction itself.
      const failure = classifyExitFailure(e);
      if (failure === 'already-gone') {
        ctx.log(`[${label}] Deja fait cote serveur - purge MLS/UI locale`);
        await mlsService.dismissGroup(convo.id).catch((e: unknown) => {
          ctx.log(
            `[${label}] dismissGroup(${convo.id}) failed - other devices keep it: ${String(e)}`
          );
        });
        await clearPendingGroupExit(ctx.storage, convo.id, ctx.log);
      } else if (failure === 'refused') {
        // Reachable and refusing. The exit is KEPT, because a server that is up and saying no is a
        // defect to find, never a decision to forget.
        ctx.log(
          `[${label}] Serveur joignable mais REFUS (${String(e)}) - sortie conservee, purge locale`
        );
      } else {
        // NO ANSWER. Not "an error to log and move past" - this is the one branch that leaves work
        // behind, so it accuses, and the row it kept is what the next reconnect replays.
        ctx.log(
          `[${label}] Serveur INJOIGNABLE (${String(e)}) - sortie CONSERVEE, rejouee a la reconnexion`
        );
      }
    }
    await purgeOrphanGroup({
      conversations,
      mlsService,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      contactKey,
      groupId: convo.id,
      deleteConversation: ctx.storage ? (key) => ctx.storage!.deleteConversation(key) : undefined,
      log: ctx.log,
    });
  }

  /**
   * Creates a new named MLS group, persists it, and selects it in the UI.
   *
   * Returns the creation's own answer unchanged: the modal that called it needs to know whether to
   * close, and a wrapper that swallowed the outcome is exactly what left it closing over a group
   * that had just been deleted server-side.
   */
  async function createNewGroup(
    nameRaw: string,
    ctx: ConversationContext
  ): Promise<ConversationOutcome> {
    return createGroup(nameRaw, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      historyBaseUrl: ctx.historyBaseUrl,
      conversations,
      selectConversation: (name) => selectConversationWithCtx(name, ctx),
      saveConversation: (name) => saveConversation(name, ctx),
      log: ctx.log,
    });
  }

  /** Invites one or more users (by ID) to the currently selected group, then refreshes the member list. No-op for DMs or channels. */
  async function inviteMembersToCurrentGroup(memberIds: string[], ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // DMs and channels cannot be invaded
    const normalized = [
      ...new SvelteSet(memberIds.map((id) => id.trim().toLowerCase()).filter(Boolean)),
    ];
    if (normalized.length === 0) return;
    // Optimistic UI: expose the invitees as pending immediately; the invite flow
    // (device fetch + bulk commit + welcomes) takes several seconds.
    pendingInvites = { groupId: convo.id, ids: normalized };
    try {
      const outcome = await inviteMembersToGroup(normalized, convo, {
        mlsService: ctx.ensureMls(),
        storage: ctx.storage,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        historyBaseUrl: ctx.historyBaseUrl,
        conversations,
        selectConversation: (name) => selectConversationWithCtx(name, ctx),
        saveConversation: (name) => saveConversation(name, ctx),
        addMessageToChat: ctx.addMessageToChat,
        log: ctx.log,
      });
      // NEVER A SILENT REFUSAL: the member is the only one who can retry an invitation.
      if (outcome.kind === 'not-added') reportBulkAdditionRefusal(outcome.reason);
      // FRESH: a roster read begun before the commit's write must not be joined (pre-Add roster).
      await loadGroupMembers(convo.id, ctx, { fresh: true });
    } catch (e) {
      // `processBulkAddition` lets only this refusal through; anything else is its own to report.
      if (!reportFollowerTabRefusal(e)) throw e;
    } finally {
      pendingInvites = null;
    }
  }

  /**
   * Re-plans a member's invitation whose KEPT commit did not land (`owedInvitations.ts`, OFF-3) and
   * tells the member every ending it does not complete - `makeLostInvitationReplanner`, bound here.
   */
  function lostInvitationReplanner(
    ctx: ConversationContext,
    mlsService: IMlsService,
    gen: RestoreGeneration
  ): OwedInvitationReplanner {
    return makeLostInvitationReplanner({
      // The session that registered it: retired by the sign-out (`invalidateRestores`).
      isCurrent: () => !gen.retired,
      conversations,
      mlsService,
      replan: (owed, convo) =>
        replanLostInvitation(owed, convo, {
          mlsService,
          storage: ctx.storage,
          userId: ctx.userId,
          deviceKeyB64: ctx.deviceKeyB64,
          historyBaseUrl: ctx.historyBaseUrl,
          conversations,
          selectConversation: (name) => selectConversationWithCtx(name, ctx),
          saveConversation: (name) => saveConversation(name, ctx),
          log: ctx.log,
          addMessageToChat: ctx.addMessageToChat,
        }),
      report: reportLostInvitation,
      afterCompleted: (convo) => loadGroupMembers(convo.id, ctx),
    });
  }

  /** What a member's answer to a join ask needs, bound to this context (`joinAnswers.ts`). */
  function joinAnswerDeps(ctx: ConversationContext): JoinAnswerDeps {
    const mlsService = ctx.ensureMls();
    return {
      mlsService,
      conversations,
      invite: (userIds, convo, answering) =>
        inviteMembersToGroup(
          userIds,
          convo,
          {
            mlsService,
            storage: ctx.storage,
            userId: ctx.userId,
            deviceKeyB64: ctx.deviceKeyB64,
            historyBaseUrl: ctx.historyBaseUrl,
            conversations,
            selectConversation: (name) => selectConversationWithCtx(name, ctx),
            saveConversation: (name) => saveConversation(name, ctx),
            addMessageToChat: ctx.addMessageToChat,
            log: ctx.log,
          },
          answering ? { answering } : {}
        ),
      collectStrayLeaves: async (groupId) =>
        (await removeStrayLeaves(mlsService, [groupId], ctx.userId, ctx.log)).includes(groupId),
      log: ctx.log,
    };
  }

  /**
   * A member ADMITS a new person who asked to join (`joinRequests.svelte.ts`): the same Add as an
   * invitation from the member list, built and signed by this device (`admitJoinRequest`). Says
   * whether the person is now in the tree, so the ask stays on screen when the Add did not happen.
   */
  async function approveJoinRequest(
    request: JoinRequest,
    ctx: ConversationContext
  ): Promise<JoinAnswerResult> {
    const result = await admitJoinRequest(request, joinAnswerDeps(ctx));
    if (result.done && selectedContact === request.groupId) {
      await loadGroupMembers(request.groupId, ctx, { fresh: true });
    }
    return result;
  }

  /**
   * A member DECLINES a new person who asked to join: their roster row and pending devices leave the
   * server (`declineJoinRequest` in `joinAnswers.ts`), which is what stops the ask coming back.
   */
  async function declineJoinRequest(
    request: JoinRequest,
    ctx: ConversationContext
  ): Promise<JoinAnswerResult> {
    return declineJoinAsk(request, joinAnswerDeps(ctx));
  }

  /**
   * Opens or creates a direct 1-to-1 conversation with the given user.
   *
   * Forwards the outcome for the same reason `createNewGroup` does.
   */
  async function startNewConversation(
    contactNameRaw: string,
    ctx: ConversationContext,
    opts?: { silent?: boolean }
  ): Promise<ConversationOutcome> {
    return startConversation(contactNameRaw, {
      mlsService: ctx.ensureMls(),
      storage: ctx.storage,
      userId: ctx.userId,
      deviceKeyB64: ctx.deviceKeyB64,
      historyBaseUrl: ctx.historyBaseUrl,
      conversations,
      selectConversation: (name) => selectConversationWithCtx(name, ctx),
      saveConversation: (name) => saveConversation(name, ctx),
      log: ctx.log,
      silent: opts?.silent,
    });
  }

  /**
   * Applies `patch` to the conversation as it stands NOW, never to a snapshot taken before an await:
   * whatever was written in between (a notice, a message) survives. A conversation gone meanwhile is
   * left gone.
   */
  function patchConversation(key: string, patch: Partial<Conversation>): void {
    const current = conversations.get(key);
    if (current) conversations.set(key, { ...current, ...patch });
  }

  /** Renames the currently selected group on the server, broadcasts the change via MLS, and writes this device's own notice under the frame's id. No-op for DMs and channels. */
  async function handleRenameGroup(name: string, ctx: ConversationContext) {
    const key = selectedContact;
    if (!key) return;
    const convo = conversations.get(key);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // only named groups can be renamed
    try {
      await renameGroupAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        newName: name,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        ownNotice: { contactName: key, addMessageToChat: ctx.addMessageToChat },
      });
      // RE-READ AFTER THE AWAIT, AND PATCH THE NAME ONLY. The send wrote our own notice into this
      // conversation meanwhile (`sendVisibleNotice`); writing back the snapshot taken before the
      // await erased it from this device's screen - the one device that had never drawn it.
      patchConversation(key, { name });
      await saveConversation(key, ctx);
      ctx.log(`Group ${key} renamed`);
    } catch (e) {
      ctx.log(`Erreur renommage: ${String(e)}`);
    }
  }

  /** Sets the currently selected group's avatar on the server, broadcasts the change via MLS, writes this device's own notice under the frame's id, and updates the UI. No-op for DMs and channels. */
  async function handleSetGroupImage(mediaId: string, ctx: ConversationContext) {
    const key = selectedContact;
    if (!key) return;
    const convo = conversations.get(key);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // only named groups carry an avatar
    try {
      await setGroupImageAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        mediaId,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        ownNotice: { contactName: key, addMessageToChat: ctx.addMessageToChat },
      });
      // Re-read and patch, for the reason `handleRenameGroup` gives.
      patchConversation(key, { imageMediaId: mediaId });
      await saveConversation(key, ctx);
      ctx.log(`Photo de groupe mise a jour (media=${mediaId})`);
    } catch (e) {
      ctx.log(`Erreur changement photo: ${String(e)}`);
    }
  }

  /** Broadcasts a "groupDeleted" message, deletes the group on the server, wipes local MLS state, removes the conversation from IndexedDB, and resets the UI. */
  async function handleDeleteGroup(ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    await exitGroupAndCleanup(
      selectedContact,
      convo,
      (mls) =>
        deleteGroupAndBroadcast({
          mlsService: mls,
          groupId: convo.id,
          userId: ctx.userId,
          deviceKeyB64: ctx.deviceKeyB64,
          log: ctx.log,
        }),
      'DELETE',
      'delete',
      ctx
    );
  }

  /**
   * Deletes the conversation locally only (IndexedDB + reactive map), with no server call and
   * no MLS broadcast.
   *
   * Used when the conversation is flagged `deletedRemotely=true`: the group has already been
   * deleted server-side by another participant; we just remove the local entry at the user's
   * request.
   */
  async function handleDeleteGroupLocally(ctx: ConversationContext) {
    if (!selectedContact) return;
    const contactKey = selectedContact;
    // Through `purgeConversation` rather than a bare `conversations.delete`, so this exit forgets
    // the group-keyed leftovers exactly like retiring does - it did not, and left orphaned
    // awaiting-history markers behind for every conversation cleared this way.
    await purgeConversation({
      conversations,
      key: contactKey,
      deleteStored: ctx.storage ? (key) => ctx.storage!.deleteConversation(key) : undefined,
    });
    selectedContact = null;
    ctx.log(`[DELETE_LOCAL] Local conversation deleted: ${contactKey.slice(0, 8)}…`);
  }

  /** Sends a "memberLeft" broadcast, de-registers from the server, forgets local MLS state, deletes the DB entry, and clears the selection. */
  async function handleLeaveGroup(ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    await exitGroupAndCleanup(
      selectedContact,
      convo,
      (mls) =>
        leaveGroupAndBroadcast({
          mlsService: mls,
          groupId: convo.id,
          userId: ctx.userId,
          deviceKeyB64: ctx.deviceKeyB64,
          log: ctx.log,
        }),
      'LEAVE',
      'leave',
      ctx
    );
  }

  /**
   * Removes a member from the currently selected group via an MLS commit, broadcasts the removal,
   * and refreshes the member list.
   *
   * IT ASKS FIRST, AND THE CONFIRMATION IS HERE RATHER THAN IN THE PANEL. Reported by the user
   * 2026-09-17 (*"le bouton pour retirer les gens des groupes est trop sensible"*): the control is a
   * 16 px `UserMinus` icon in a member row, and one press committed the removal. Its two siblings -
   * the community kick and the channel-access removal - both already open a `danger` dialog, so this
   * was the odd one out rather than a decision.
   *
   * THE GESTURE IS NOT UNDOABLE, WHICH IS WHAT EARNS THE DIALOG. This is an MLS commit: the epoch
   * advances, the removed device cannot decrypt anything after it, and bringing the person back
   * needs a fresh Welcome rather than a click that puts the row back. A confirmation on a reversible
   * action is friction; on this one it is the only chance to notice.
   *
   * It guards the CHOKE POINT and not the button. `ChatGroupPanel` takes `onRemoveMember` as a
   * prop, so a second caller would be one more unguarded path - asking here means every caller
   * inherits it, which is the same reason the deletion paths do it at their own call site.
   */
  async function handleRemoveMember(memberId: string, ctx: ConversationContext) {
    const key = selectedContact;
    if (!key) return;
    const convo = conversations.get(key);
    if (!convo) return;
    const confirmed = await showConfirm(chat_group_remove_member_confirm(), {
      danger: true,
      confirmLabel: common_remove_label(),
    });
    if (!confirmed) return;
    // THE ROSTER IS REREAD WHENEVER THE SERVER RECORDED THE REMOVAL - on success, and when only its
    // commit is owed (`MemberRemovalNotCommittedError`): the person is out either way. Outside the
    // `try`, so a failed reread is never reported as a failed removal.
    let recorded: boolean;
    try {
      // `already-out` is a complete removal too (another commit took their leaves): no error.
      const outcome = await removeMemberAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        memberId,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        ownNotice: { contactName: key, addMessageToChat: ctx.addMessageToChat },
      });
      recorded = true;
      ctx.log(`[REMOVE_MEMBER] ${memberId.slice(0, 8)} removed from the group (${outcome})`);
    } catch (e) {
      // NEVER A LOG LINE ALONE: every ending reaches the person who asked, classified by TYPE.
      ctx.log(`[REMOVE_MEMBER] ${memberId.slice(0, 8)} not fully removed: ${String(e)}`);
      // Recorded or not is the error's TYPE; the sentence is the follower tab's when that is why.
      recorded = e instanceof MemberRemovalNotCommittedError;
      if (!reportFollowerTabRefusal(e)) reportMemberRemovalFailure(e);
    }
    if (!recorded) return;
    membershipCache.delete(convo.id);
    groupMembers = groupMembers.filter((m) => m !== memberId);
    await loadGroupMembers(convo.id, ctx).catch((e: unknown) =>
      ctx.log(`[REMOVE_MEMBER] member list not reread after the removal: ${String(e)}`)
    );
  }

  // ── Exposed API ───────────────────────────────────────────────────────────

  return {
    /** Reactive SvelteMap of all conversations keyed by conversation name. */
    conversations,
    /** True once the initial IndexedDB restore finished; the map is then authoritative. */
    get conversationsRestored() {
      return conversationsRestored;
    },
    /**
     * True once every pass that can add a conversation has finished - the restore AND the FCM
     * cache injections that follow it. What a deep-link landing must consult before deciding a
     * target is not on this device; see {@link pendingConversationSources}.
     */
    get conversationSourcesSettled() {
      return conversationsRestored && pendingConversationSources === 0;
    },
    /** Opens a span during which a conversation may still appear. Always paired in a `finally`. */
    beginConversationSource() {
      pendingConversationSources += 1;
    },
    /** Closes one such span. Floored at zero so an unbalanced call cannot wedge the landing shut. */
    endConversationSource() {
      pendingConversationSources = Math.max(0, pendingConversationSources - 1);
    },
    /** The conversation drawn from the local store before the session is up, or null (F1). */
    get landingPreviewKey() {
      return landingPreviewKey;
    },
    previewLandingTarget,
    previewSelect,
    endLandingPreview,
    discardLandingPreview,

    // UI state
    /** Currently selected conversation name (null when no conversation is open). */
    get selectedContact() {
      return selectedContact;
    },
    set selectedContact(v: string | null) {
      selectedContact = v;
    },
    /** Returns 'chat' when a conversation is selected, 'list' otherwise (mobile layout helper). */
    get mobileView() {
      return selectedContact ? 'chat' : 'list';
    },
    /** Whether the conversation list drawer is open (mobile). */
    get isConversationDrawerOpen() {
      return isConversationDrawerOpen;
    },
    set isConversationDrawerOpen(v: boolean) {
      isConversationDrawerOpen = v;
    },
    /** Whether the channel members side drawer is open. */
    get sidePanel() {
      return sidePanel;
    },
    /** Whether the channel settings modal is open. */
    /** Deduplicated list of userIds currently in the selected group. */
    get groupMembers() {
      return groupMembers;
    },
    set groupMembers(v: string[]) {
      groupMembers = v;
    },
    /** User IDs with an invite in flight for the currently selected group (optimistic UI). */
    get pendingGroupInvites(): string[] {
      if (!pendingInvites || !selectedContact) return [];
      const convo = conversations.get(selectedContact);
      return convo && convo.id === pendingInvites.groupId ? pendingInvites.ids : [];
    },
    /** True while history is being fetched and decrypted for the selected conversation. */
    get isLoadingHistory() {
      return isLoadingHistory && (skeletonSalon === null || skeletonSalon === selectedContact);
    },
    /** Last send or membership error message to display to the user. */
    get sendError() {
      return sendError;
    },
    set sendError(v: string) {
      sendError = v;
    },
    /** Controlled value of the "new direct conversation" input field. */
    get newContactInput() {
      return newContactInput;
    },
    set newContactInput(v: string) {
      newContactInput = v;
    },
    /** Controlled value of the "new group" input field. */
    get newGroupInput() {
      return newGroupInput;
    },
    set newGroupInput(v: string) {
      newGroupInput = v;
    },
    /** Controlled value of the "new channel" input field. */
    get newChannelInput() {
      return newChannelInput;
    },
    set newChannelInput(v: string) {
      newChannelInput = v;
    },
    /** Reference to the chat scroll container used for auto-scroll. */
    get chatContainer() {
      return chatContainer;
    },
    set chatContainer(v: HTMLElement | undefined) {
      chatContainer = v;
    },
    /** Derived conversation object for the currently selected contact (null if none). */
    get currentConvo() {
      return currentConvo;
    },

    // actions
    /** Persists the given conversation's metadata to IndexedDB. */
    saveConversation,
    /** Fetches and decrypts network history for a conversation, then reloads from DB. */
    loadHistoryForConversation,
    /** Full-text search over a channel's entire server history (decrypts + merges hits into view). */
    searchChannelHistory,
    /** Clears the in-memory channel history TTL cache (one channel or all). */
    invalidateChannelHistoryCache,
    noteLiveStreamTransition,
    /** Reads saved conversations from IndexedDB and populates the reactive map. */
    loadAndRestoreConversations,
    invalidateRestores,
    forgetUnconfirmedSalonDraws,
    /** Prepends an older page of messages from IndexedDB to the conversation. */
    loadOlderMessages,
    /** Asks a peer for the page below what this device holds, once the local store is exhausted. */
    requestOlderFromPeers,
    /** Selects a conversation without a ctx (clears unread badge). */
    selectConversation,
    /** Selects a conversation with a ctx (also verifies membership). */
    selectConversationWithCtx,
    /** Deselects the active conversation and closes the drawer. */
    goBackToMenu,
    onThreadLeft,
    openConversationDrawer,
    closeConversationDrawer,
    openSidePanel,
    closeSidePanel,
    toggleSidePanel,
    /**
     * Reads and stores the user-level ADMITTED roster of an MLS group (`user-members`, seats awaiting
     * admission left out). `fresh` skips an identical read already in flight.
     */
    loadGroupMembers,
    /** Checks and caches whether the current user is still in the given conversation. */
    verifyCurrentUserMembership,
    /** Creates a new named MLS group and selects it. */
    createNewGroup,
    /** Invites one or more users to the currently selected group. */
    inviteMembersToCurrentGroup,
    approveJoinRequest,
    declineJoinRequest,
    /** Opens or creates a direct 1-to-1 conversation with the given user. */
    startNewConversation,
    /** Renames the currently selected group and broadcasts the change. */
    handleRenameGroup,
    /** Sets the currently selected group's avatar and broadcasts the change. */
    handleSetGroupImage,
    /** Deletes the currently selected group and clears the UI. */
    handleDeleteGroup,
    /** Removes only the local conversation entry (no server call). Used when the group was deleted remotely. */
    handleDeleteGroupLocally,
    /** Leaves the currently selected group and clears the UI. */
    handleLeaveGroup,
    /** Removes a member from the currently selected group. */
    handleRemoveMember,
  };
}
