/**
 * Reactive composable owning all conversation state and operations:
 * - The conversations SvelteMap
 * - Selection, archive/restore
 * - Group members + membership verification
 * - Group-level operations (create, rename, delete, invite, kick)
 * - Storage helpers (save, load history, reload)
 */
import { SvelteDate, SvelteMap, SvelteSet } from 'svelte/reactivity';
import { foldForSearch } from '$lib/utils/textFold';
import type { IStorage } from '$lib/db';
import type { IMlsService } from '$lib/mlsService';
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
import type { ChannelPollMeta } from '$lib/services/ChannelService';
import { applyChannelReactionFrame } from '$lib/stores/reactionStore.svelte';
import {
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
  startNewConversation as startConversation,
  type ConversationOutcome,
} from '$lib/utils/chat/groupCreation';
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
import { compareMessageOrder } from '$lib/utils/chat/messageOrder';
import { parseReadWatermarks } from '$lib/utils/chat/readState';
import { mergeMessagePage } from '$lib/utils/chat/messageMerge';
import { nextEchoMessages } from '$lib/utils/chat/salonEcho';
import { clearUnsentSalonTexts } from '$lib/utils/chat/salonUnsent';
import { noteSalonOpened, reconcileSalonUnreadFromServer } from '$lib/utils/chat/salonUnread';
import {
  flushSalonReadMarks,
  owedSalonReadMarks,
  salonMarksAfterLoad,
} from '$lib/utils/chat/salonReadMarkQueue';
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
  // True once the initial IndexedDB restore has populated the map, so consumers (e.g. the
  // /posts mini-panel) can treat the live map as authoritative and reflect deletions
  // instead of resurrecting stale rows from their own snapshot.
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

  function invalidateChannelHistoryCache(channelConversationId?: string) {
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
      endLandingUnlessTarget(null);
      selectedContact = null;
      isConversationDrawerOpen = false;
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
    options?: { force?: boolean }
  ) {
    // Channel conversations: load via REST API instead of MLS replay
    if (isChannelConversationId(contactName)) {
      await loadChannelHistory(contactName, ctx, options?.force);
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
    if (isSelected) isLoadingHistory = true;
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
      // The replay runs in a bulk-ingest window so an encrypted checkpoint flushes on close;
      // its progress markers are committed only afterwards (never ahead of persisted state).
      try {
        const commit = await withMlsBulkIngest(ctx.ensureMls(), () =>
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
          })
        );
        commit?.();
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

  /** Loads channel history from the server (source of truth) into memory only - never IndexedDB. */
  async function loadChannelHistory(
    channelConversationId: string,
    ctx: ConversationContext,
    force = false
  ) {
    const { channelService } = await import('$lib/services/ChannelService');
    const { decodeChannelMessageRow, UnreadableRowTally, V1_SESSION_NOT_HELD } =
      await import('$lib/utils/chat/channelCrypto');
    const { olderMessagesNotice, keepNoticeOnTop } =
      await import('$lib/utils/chat/olderMessagesNotice');

    const rawId = channelConversationId.replace(/^channel_/, '');
    const convo = conversations.get(channelConversationId);
    if (!convo) return;

    // Current until an event says otherwise - see `channelHistoryLoadedAt`.
    const cached = channelHistoryLoadedAt.get(channelConversationId);
    if (!force && cached && cached.userId === ctx.userId) return;

    // ONLY THE LATEST LOAD STARTED FOR THIS SALON MAY MERGE (found reviewing #1761). The page is
    // authoritative for its window, so an older load finishing last would drop a row a newer one
    // had just decoded - see `loadGenerations.ts` for the exact sequence. Not a refetch afterwards:
    // that was the heal that hid the race.
    const generation = salonLoadGenerations.begin(channelConversationId);
    const isSelected = selectedContact === channelConversationId;
    if (isSelected) {
      isLoadingHistory = true;
      salonSkeletonOwner = generation;
    }

    try {
      if (ctx.storage) {
        await ctx.storage.deleteMessagesForConversation(channelConversationId).catch((e) => {
          ctx.log(
            `[CHANNEL] stale local rows of ${channelConversationId} not cleared before the load: ${String(e)}`
          );
        });
      }
      // Nothing to hydrate: a Graine seed is already in the local store or it is not, and the
      // server holds none to fetch. A row this device has no seed for is REPORTED unreadable by
      // `decodeChannelMessageRow` rather than silently skipped, and repaired by WP-33.
      //
      // THE READ MARKS COME WITH EVERY LOAD, beside the page they describe: the live `channel.read`
      // events only carry what moved while this device was connected, so a load is the one moment
      // the whole picture can be taken. Their failure costs the "Lu par" row and nothing else - the
      // page still loads, and the next load asks again.
      const [rows, rawMarks] = await Promise.all([
        channelService.listMessages(rawId, 200),
        channelService.listReadMarks(rawId).catch((e) => {
          console.warn(
            `[CHANNEL_READ] read marks of ${rawId.slice(0, 8)} not loaded - who read what stays` +
              ` unknown here until the next load: ${String(e)}`
          );
          return undefined;
        }),
      ]);
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
        for (const msg of rows) {
          const decoded = await decodeChannelMessageRow(rawId, msg, meLower, tally);
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
        conversations.set(channelConversationId, {
          ...current,
          // FIRST after the merge too: a reload can hold rows older than this page (section 21.7).
          messages: keepNoticeOnTop(
            mergeMessagePage(current.messages, loadedEdited),
            channelConversationId
          ),
          ...(readWatermarks !== undefined ? { readWatermarks } : {}),
        });
        channelHistoryLoadedAt.set(channelConversationId, {
          loadedAt: Date.now(),
          userId: ctx.userId,
        });
      }
    } catch (e) {
      ctx.log(`[CHANNEL] History load failed: ${String(e)}`);
    } finally {
      // The load that raised the skeleton last lowers it: a superseded load leaves it to a newer one
      // that raised it again, never to one that did not (see `salonSkeletonOwner`).
      if (salonSkeletonOwner === generation) {
        isLoadingHistory = false;
        salonSkeletonOwner = 0;
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
    const { decodeChannelMessageRow, UnreadableRowTally } =
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
    for (const row of rows) {
      const decoded = await decodeChannelMessageRow(rawId, row, meLower, tally);
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

  /** Reads all saved conversations from IndexedDB, verifies MLS state consistency, and populates the conversations map. */
  async function loadAndRestoreConversations(ctx: ConversationContext) {
    if (!ctx.storage) return;
    // The restore supersedes any local preview: from here the map is the session's.
    landingPreviewKey = null;
    landingPreviewOwner = null;
    try {
      await loadExistingConversations({
        // The landing target stays pending while it is displayed, so this keeps the thread on
        // screen through the rebuild - see `preserveMessagesOf`.
        preserveMessagesOf: notifNav.pending,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
        storage: ctx.storage,
        mlsService: ctx.ensureMls(),
        conversations,
        messageReactions: ctx.messageReactions,
        archivedConversationIds: [],
        historyBaseUrl: ctx.historyBaseUrl,
        log: ctx.log,
        onArchivedIdsChange: () => {},
      });
    } finally {
      conversationsRestored = true;
      // A frame that reached the handler while this map was still empty was left in the server
      // queue rather than dropped. The restore finishing is what makes it readable, so it is the
      // trigger to ask again - there is no timer waiting to notice.
      ctx.ensureMls().notifyConversationsRestored();
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
    // Backing out of the thread ends any landing, or the target would be re-selected instantly.
    endLandingUnlessTarget(null);
    dismissSidePanelIfAny();
    if (mobileConvoHistoryClose) {
      // Clear state synchronously so any rapid click on a new conversation after
      // pressing back pushes a fresh history overlay rather than reusing the stale one.
      // abandonHistoryOverlay removes the entry from the stack and calls history.back()
      // with ignoreNextPop=true, preventing the old close callback from firing and
      // accidentally clearing a newly-selected conversation.
      selectedContact = null;
      isConversationDrawerOpen = false;
      const ref = mobileConvoHistoryClose;
      mobileConvoHistoryClose = null;
      abandonHistoryOverlay(ref);
      return;
    }
    selectedContact = null;
    isConversationDrawerOpen = false;
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
   * Fetches the deduplicated list of member userIds for an MLS group and stores them in
   * groupMembers. No-op for channel conversations, and for one this device is no longer in.
   *
   * THE ROSTER OF A RETIRED CONVERSATION IS NOT OURS TO ASK FOR. `GET /api/mls/groups/:id/members`
   * is members-only by design, so on a device holding a Remove commit the request has exactly one
   * possible outcome, and it is a 403 in the console of every removed device. Both selection paths
   * fire this one line above `verifyCurrentUserMembership`, which was taught the same fact on
   * 2026-08-23 - this call site was not, which is why GRP-3 still recorded the 403 the next day.
   * The discriminator is durable, local and already in the row (see `membershipIsDurablyLost`).
   *
   * An empty roster is the ANSWER here rather than a fallback: there is no membership to show.
   */
  async function loadGroupMembers(id: string, ctx: ConversationContext | null) {
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
      groupMembers = await fetchUniqueGroupMembers(ctx.ensureMls(), id);
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
      await inviteMembersToGroup(normalized, convo, {
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
      await loadGroupMembers(convo.id, ctx);
    } finally {
      pendingInvites = null;
    }
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

  /** Renames the currently selected group on the server, broadcasts the change via MLS, and appends a system message. No-op for DMs and channels. */
  async function handleRenameGroup(name: string, ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // only named groups can be renamed
    try {
      await renameGroupAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        newName: name,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
      });
      conversations.set(selectedContact, { ...convo, name });
      await saveConversation(selectedContact, ctx);
      ctx.log(`Group ${selectedContact} renamed`);
    } catch (e) {
      ctx.log(`Erreur renommage: ${String(e)}`);
    }
  }

  /** Sets the currently selected group's avatar on the server, broadcasts the change via MLS, and updates the UI. No-op for DMs and channels. */
  async function handleSetGroupImage(mediaId: string, ctx: ConversationContext) {
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    if ((convo.conversationType ?? 'group') !== 'group') return; // only named groups carry an avatar
    try {
      await setGroupImageAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        mediaId,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
      });
      conversations.set(selectedContact, { ...convo, imageMediaId: mediaId });
      await saveConversation(selectedContact, ctx);
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
    if (!selectedContact) return;
    const convo = conversations.get(selectedContact);
    if (!convo) return;
    const confirmed = await showConfirm(chat_group_remove_member_confirm(), {
      danger: true,
      confirmLabel: common_remove_label(),
    });
    if (!confirmed) return;
    try {
      await removeMemberAndBroadcast({
        mlsService: ctx.ensureMls(),
        groupId: convo.id,
        memberId,
        userId: ctx.userId,
        deviceKeyB64: ctx.deviceKeyB64,
      });
      membershipCache.delete(convo.id);
      groupMembers = groupMembers.filter((m) => m !== memberId);
      await loadGroupMembers(convo.id, ctx);
      ctx.log(`${memberId} retire du groupe.`);
    } catch (e) {
      ctx.log(`Erreur retrait membre: ${String(e)}`);
    }
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
      return isLoadingHistory;
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
    openConversationDrawer,
    closeConversationDrawer,
    openSidePanel,
    closeSidePanel,
    toggleSidePanel,
    /** Fetches and stores the deduplicated member list for an MLS group. */
    loadGroupMembers,
    /** Checks and caches whether the current user is still in the given conversation. */
    verifyCurrentUserMembership,
    /** Creates a new named MLS group and selects it. */
    createNewGroup,
    /** Invites one or more users to the currently selected group. */
    inviteMembersToCurrentGroup,
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
