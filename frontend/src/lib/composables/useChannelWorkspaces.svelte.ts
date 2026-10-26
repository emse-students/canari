import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { slugify } from '$lib/utils/textFold';
import {
  clearSalonUnreadLocally,
  communityUnreadUpTo,
  reconcileSalonUnreadFromServer,
} from '$lib/utils/chat/salonUnread';
import { flushSalonReadMarks } from '$lib/utils/chat/salonReadMarkQueue';
import { ChannelApiError, ChannelService } from '$lib/services/ChannelService';
import { RefreshFailedError, SessionExpiredError, SignOutInProgressError } from '$lib/stores/auth';
import { ApiRefusalError } from '$lib/utils/apiRefusal';
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
  sendChannelEdit,
  sendChannelReaction,
  sendEncryptedChannelMessage,
} from '$lib/utils/chat/channelCrypto';
import {
  markCommunityListed,
  narrowHistoryVisibility,
  registerChannelWorkspace,
  registerCommunityHistoryVisibility,
} from '$lib/utils/graine/runtime';
import type { GraineHistoryVisibility } from '$lib/crypto/graineConstants';
import { buildConversationRow } from '$lib/utils/chat/conversations';
import { currentUserId } from '$lib/stores/userState.svelte';
import { getSavedUserId } from '$lib/stores/user';
import { applyChannelEdit, revertChannelEdit } from '$lib/utils/chat/channelEdit';
import { deliverSalonWrite, nothingLeftTheDevice } from '$lib/utils/chat/salonOwed';
import { applyChannelReactionFrame, getChannelReactions } from '$lib/stores/reactionStore.svelte';
import {
  activeReactions,
  canAddDistinctReactionEmoji,
  MAX_DISTINCT_MESSAGE_REACTIONS,
} from '$lib/utils/chat/messageReactions';
import { showToast } from '$lib/stores/toast.svelte';
import { notifNav } from '$lib/stores/notifNav.svelte';
import { m } from '$lib/paraglide/messages';
import { resolveDisplayNames } from '$lib/utils/users/displayName';
import { notifyReaction } from '$lib/utils/chat/reactionNotify';
import { describeCommunityRefusal } from '$lib/utils/chat/communityErrors';
import {
  ensureCommunityDistributionGroup,
  enterPrivateSalonGroup,
} from '$lib/utils/graine/distributionGroup';
import { leaveKeyGroupToMainTab } from '$lib/utils/graine/followerTabKeyGroup';
import { requestCommunityHistory } from '$lib/utils/graine/repair';
import { orderByIds } from '$lib/utils/chat/channelOrder';
import { GraineSealUnavailableError } from '$lib/utils/graine/sealUnavailable';
import { sealUnavailableMessage } from '$lib/utils/graine/sealUnavailableMessage';
import {
  beginSalonEntry,
  beginSalonListing,
  currentSalonSession,
  isCurrentSalonSession,
  openSalonSendGate,
  resetSalonSendGate,
  settleSalonEntry,
  settleSalonListing,
  type SettledListing,
} from '$lib/utils/graine/salonSendGate';
import { abandonMlsReadyWaiters, whenMlsReady } from '$lib/composables/session/mlsReadiness';
import {
  readWorkspaceSnapshot,
  serializeWorkspaceSnapshot,
  storeWorkspaceSnapshot,
} from '$lib/utils/chat/workspaceSnapshot';
import { isTransportFailure } from '$lib/utils/transportFailure';
import { communityLedgerKey, createListingLedger } from '$lib/utils/chat/listingLedger';
import { forgetCommunityGraine } from '$lib/utils/graine/forget';
import { admitInvitedMember } from '$lib/utils/graine/admitNewcomer';
import { signDirectAdmission } from '$lib/utils/graine/admissionIssue';

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
  /** Server-authoritative: true when the current user may govern salons here (rename, delete, access, write policy). Defaults to false until the backend listing confirms it. */
  viewerCanManageChannels?: boolean;
  /** What this community lets a newcomer read. Absent until the backend listing says. */
  historyVisibility?: GraineHistoryVisibility;
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
  /**
   * Opens (or creates) a direct MLS conversation with the given user. Pass { silent: true } to skip
   * UI selection (e.g. background key distribution).
   *
   * The result is deliberately `unknown`: the creation paths answer WHY they refused, for the
   * creation modal, and this caller is background key distribution - it has no screen to say it on
   * and already treats a failure as "the member misses one key, their next request fetches it".
   * Typing the answer here would invite a second reading of it that nothing would act on.
   */
  startDirectConversation?: (targetUserId: string, opts?: { silent?: boolean }) => Promise<unknown>;
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
  /**
   * The salons whose last page this device stores (F4), conversation ids. Optional: a context with
   * no store has nothing at rest to sweep.
   */
  storedSalonPageIds?: () => Promise<string[]>;
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

/** What may list the communities again after a listing gave up (`retryFailedListing`). */
export type ListingRetryTrigger = 'reconnect' | 'foreground';

/** What started a listing: a direct call (post-login, a join), or a retry trigger. */
type ListingOrigin = 'direct' | ListingRetryTrigger;

/** Back-off delays in ms for workspace list retries after transient failures. */
const WORKSPACE_LOAD_RETRY_DELAYS = [1_000, 3_000, 7_000];

/** Creates and returns the reactive channel/workspace store: sidebar state, API operations (create, rename, delete, invite, leave, image update), and real-time event handlers. */
export function useChannelWorkspaces() {
  let channelWorkspaces = $state<ChannelSidebarWorkspace[]>([]);

  /**
   * What this device learned LIVE about each salon and community - created or heard of (present),
   * deleted, left or removed (gone) - dated by a tick a listing reads before its request goes out.
   *
   * IT EXISTS TO DATE A SERVER LISTING AGAINST A LOCAL FACT. `executeWorkspaceLoadAttempt` ends by
   * deleting everything the listing did not mention, and between the request going out and that
   * prune it awaits an MLS group join and a channel listing PER COMMUNITY - seconds, on a real
   * account. Anything created in that window is absent from an answer that was already on its way
   * (a community vanished 1.5 s after its creation, 2026-08-20; a salon HEARD OF live was pruned the
   * same way, dev 2026-10-26), and anything removed in it is still in that answer. Every live
   * insertion goes through {@link addChannelToWorkspace} / {@link ensureWorkspaceForChannelEvent} /
   * the two creations, and every live removal through {@link removeChannelFromWorkspaces} /
   * {@link purgeWorkspaceLocally}; the listing itself writes through neither. See `listingLedger.ts`.
   */
  const ledger = createListingLedger();
  let selectedChannelConversationId = $state('');
  /**
   * Whether a community load is in flight. REACTIVE because the notification landing waits on it:
   * a target channel missing while the post-login load is still running is not missing yet, and
   * the landing must re-run when that load settles rather than start a second one.
   */
  let isLoadingWorkspaces = $state(false);
  /** A join landed while a listing was in flight; that listing's answer predates it. */
  let joinedCommunityReloadOwed = false;
  /**
   * A reconnect or a foreground landed while a listing was in flight, and was not that listing's own
   * traffic (see {@link retryFailedListing}). If that listing then gives up, it gave up on the link
   * it STARTED on, so the trigger is owed one more listing - an event, not a clock.
   */
  let owedRetry: ListingRetryTrigger | null = null;
  /**
   * The ONE reconnect retry the last give-up earned. THE BOUND ON THE RECONNECT: a reconnect is any
   * answer after a transport failure, so an endpoint that fails while every other call answers would
   * otherwise cycle for ever (give up -> unreachable -> a probe answers -> reconnect -> list again,
   * ~every 11 s). A listing earns this only when it gives up, and only if a reconnect did not start
   * it: a reconnect's listing that gives up earns nothing. The foreground starts the count again.
   */
  let reconnectRetryEarned = false;
  /** What started the listing in flight - a reconnect's listing earns no reconnect retry. */
  let activeListingOrigin: ListingOrigin = 'direct';
  /**
   * True while the listing's OWN request is on the wire. A reconnect landing then may be that very
   * request's answer (`trackedFetch` -> `notifyServerReachable`), so it proves nothing new about the
   * link and is owed nothing; one landing in the listing's back-off cannot be its traffic.
   */
  let listingAttemptInFlight = false;
  /**
   * Whether the last listing that gave up reached NOBODY (a transport failure) rather than being
   * failed by an answer. Decides what the salon send gate is told: `unreachable` keeps held sends
   * waiting for the reconnect's listing, `failed` refuses them.
   */
  let lastGiveUpUnreachable = false;
  /**
   * Which listing owns `isLoadingWorkspaces`. A listing that outlived a sign-out is SUPERSEDED by the
   * next session's (`globalChannels` is a singleton, and the flag would otherwise refuse the new
   * account's post-login listing for as long as the old one's retry ladder ran), and only the
   * listing that still owns the flag may drop it.
   */
  let activeListing = 0;
  /** The session (`beginSalonListing`'s token) the in-flight listing belongs to. */
  let activeListingSession = -1;

  /**
   * Thrown inside a listing that outlived its session, at the first point it would have written:
   * the walk stops, nothing of the leaving account reaches the next one, and the retry loop ends
   * without recording a failure for a session that is not its own.
   */
  class ListingOutlivedSessionError extends Error {
    constructor(where: string) {
      super(`[WORKSPACE-LOAD] listing of a previous session stopped before ${where}`);
      this.name = 'ListingOutlivedSessionError';
    }
  }

  /**
   * Stops a listing whose session ended (sign-out) before it writes `where`. Called after every
   * await of the walk: a sign-out can only land across one.
   */
  function assertListingSession(session: number, where: string): void {
    if (isCurrentSalonSession(session)) return;
    throw new ListingOutlivedSessionError(where);
  }
  let workspacesLoadError = $state<string | null>(null);

  /**
   * The account `channelWorkspaces` belongs to, or `null` while it belongs to nobody (before the
   * first listing or snapshot, after a sign-out). Set by {@link hydrateFromSnapshot} and by every
   * listing; the saved snapshot is written only for it, and the app shell draws the list before the
   * session only when it is the signed-in account's.
   */
  let workspacesOwner = $state<string | null>(null);
  /**
   * Whether a listing of THIS session has answered. False while the list on screen is the saved
   * snapshot - stale data being refreshed, which the sidebar says - or nothing at all.
   */
  let workspacesConfirmed = $state(false);
  /** The text last saved, so a change that does not change the snapshot writes nothing. */
  let lastSnapshotText = '';

  // THE SNAPSHOT FOLLOWS THE FIELD, NOT THE PATHS THAT WRITE IT (F1). Some twenty paths assign
  // `channelWorkspaces` - the listing, its prune, a creation, a rename, a reorder, a leave, a
  // deletion, a pushed event - and a copy refreshed by each of them would be stale by the first one
  // that forgot. One effect reads the list and saves it whenever it changes, for its owner only.
  //
  // THE OWNER IS CHECKED AGAINST THE DEVICE'S SIGN-IN RECORD TOO, not only this page's memory. A
  // sign-out in ANOTHER tab clears `canari_saved_user` and every slot, but leaves this tab's
  // `currentUserId()` on the account that left: without the durable check, this tab's next change
  // would write the signed-out account's list back.
  $effect.root(() => {
    $effect(() => {
      const owner = workspacesOwner;
      if (owner === null || owner !== currentUserId()) return;
      const text = serializeWorkspaceSnapshot(owner, channelWorkspaces);
      if (text === lastSnapshotText) return;
      if (getSavedUserId() !== owner) {
        console.warn(
          '[WORKSPACE-SNAPSHOT] not saved: this device is no longer signed in as the list owner (signed out in another tab?)'
        );
        return;
      }
      lastSnapshotText = text;
      storeWorkspaceSnapshot(owner, text);
    });
  });

  const service = new ChannelService();

  /**
   * Decides whether a workspace-load failure is worth retrying, from the error's TYPE.
   *
   * Retryable means one thing: NOBODY DECIDED ANYTHING. Either the request never reached an
   * answer, or the answer was the server saying it is unwell - and a second identical request can
   * change both. Everything else is a decision, and asking again gets the same one.
   *
   * IT USED TO BE A LIST OF WORDS - `fetch`, `network`, `timeout`, `abort`,
   * `err_internet_disconnected` - plus a regex hunting a three-digit number in the response body
   * to recover a status the throw had been holding all along: `ChannelApiError` has carried
   * `status` since it was introduced and nothing here read it. The list was wrong in both
   * directions. A refusal whose body happens to contain one of those words was retried three
   * times against a server that had already decided, and a real 502 was retried for the accident
   * that the regex found digits in its sentence rather than because anyone classified it.
   */
  function isRetryableLoadError(error: unknown): boolean {
    // The server answered. Only its own 5xx is worth asking again; a 4xx is a decision about us.
    if (error instanceof ApiRefusalError) return error.status >= 500;
    // The refresh endpoint answered something that is not a verdict on the session - transient by
    // construction, since 401 and 403 leave as `SessionExpiredError` instead.
    if (error instanceof RefreshFailedError) return true;
    // NOBODY ANSWERED: the one predicate, by type (`transportFailure.ts`). It is what reads Tauri's
    // `error sending request for url ...` as the network failure it is - that bare string used to
    // fall through every test here and give up as `non-retryable` (Mi 9T, `v1.2.7-alpha.1`).
    if (isTransportFailure(error)) return true;
    // A request cancelled under the listing carries no status either: nothing was decided.
    return error instanceof DOMException && error.name === 'AbortError';
  }

  /**
   * Performs a single attempt to fetch and merge the workspace/channel list.
   * Mutates `channelWorkspaces` on success; on failure the existing list is left untouched.
   */
  async function executeWorkspaceLoadAttempt(
    ctx: ChannelWorkspaceContext,
    session: number
  ): Promise<void> {
    assertListingSession(session, 'asking for the communities');
    // READ BEFORE THE REQUEST GOES OUT, not after it comes back. The server answers about the
    // moment it was asked, so anything this device creates from here on is newer than the answer
    // whatever order the two happen to complete in.
    const epochAtRequest = ledger.tick;
    const landingAtRequest = notifNav.landing;
    const backendWorkspaces = await service.listUserWorkspaces();
    assertListingSession(session, 'the community rows');
    const validChannelConversationIds: string[] = [];
    const validWorkspaceSlugs = new SvelteSet<string>();

    // EVERY COMMUNITY ROW FIRST, IN THE SERVER'S ORDER, THEN THEIR SALONS SIDE BY SIDE.
    //
    // The walk used to be one community after another, each paying its key-group read, its roster
    // read and its salon listing before the next one started: measured on a production web console
    // 2026-10-12 (`v1.2.5`), 7 communities were 21+ requests in a row and `communities/channels
    // loaded` came 2.87 s after the first one went out - every salon row, and the unread counts asked
    // after this load, waiting behind the slowest chain repeated seven times. Nothing one community
    // does reads another's: the key-group join is coalesced PER SCOPE (`ensureDistributionGroupFor`),
    // and each community only appends to its own sidebar entry. So the chains run together and the
    // load costs the longest one. The rows are upserted synchronously first so the sidebar's order
    // stays the server's whatever order the chains finish in.
    //
    // SETTLED, NOT RACED: an attempt that fails is retried by the caller, and a retry starting while
    // a sibling chain of the failed attempt still runs would be two loads at once - the overlap
    // `isLoadingWorkspaces` exists to forbid. So every chain is awaited, and the first failure is
    // rethrown only then.
    const prepared: { sidebarWorkspace: ChannelSidebarWorkspace; workspaceId: string }[] = [];
    for (const workspace of backendWorkspaces) {
      // A COMMUNITY THIS DEVICE LEFT, OR WAS REMOVED FROM, AFTER THE QUESTION is in an answer that
      // predates it; drawing it back would resurrect what the member just saw go.
      const slug = workspaceSlugOf(workspace);
      if (
        slug !== null &&
        ledger.learnedSince(communityLedgerKey(slug), epochAtRequest) === 'gone'
      ) {
        console.debug(
          `[WORKSPACE-LOAD] community ${slug} not restored: listed by the server, but removed on this device after the listing was asked (tick ${epochAtRequest})`
        );
        continue;
      }
      const sidebarWorkspace = upsertWorkspaceFromDto(workspace);
      const workspaceId = sidebarWorkspace.workspaceDbId;
      if (!workspaceId) continue;
      validWorkspaceSlugs.add(sidebarWorkspace.id);
      prepared.push({ sidebarWorkspace, workspaceId });
    }

    const outcomes = await Promise.allSettled(
      prepared.map(({ sidebarWorkspace, workspaceId }) =>
        loadCommunitySalons(
          ctx,
          sidebarWorkspace,
          workspaceId,
          validChannelConversationIds,
          session,
          epochAtRequest
        )
      )
    );
    const firstFailure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );
    if (firstFailure) {
      const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
      ctx.log(`[WORKSPACE-LOAD] ${failed}/${outcomes.length} community(ies) failed to load`);
      throw firstFailure.reason;
    }
    assertListingSession(session, 'the selected salon history');

    const selectedChannel = ctx.getSelectedConversationId?.();
    if (selectedChannel && isChannelConversationId(selectedChannel) && ctx.reloadChannelHistory) {
      await ctx.reloadChannelHistory(selectedChannel);
    }

    assertListingSession(session, 'the prune');
    await pruneAfterLoad(
      ctx,
      epochAtRequest,
      validChannelConversationIds,
      validWorkspaceSlugs,
      session,
      landingAtRequest
    );
  }

  /**
   * One community's half of a load: its key group, its salons, their sidebar rows and conversations.
   *
   * Appends every salon it finds to `validChannelConversationIds`, which the prune reads once every
   * community has answered. Runs beside the other communities' - see `executeWorkspaceLoadAttempt`.
   */
  async function loadCommunitySalons(
    ctx: ChannelWorkspaceContext,
    sidebarWorkspace: ChannelSidebarWorkspace,
    workspaceId: string,
    validChannelConversationIds: string[],
    session: number,
    epochAtRequest: number
  ): Promise<void> {
    // THE KEY GROUP AND THE SALON ROWS GO SIDE BY SIDE (F3, 2026-10-14). The salons used to be
    // listed only once the key group had answered - `distribution-group`, then `members`, then the
    // roster comparison: two serial round trips between the rail and the salon rows, 466 ms on
    // Wi-Fi and 1.8 s on a slow link with a 4x renderer (Mi 9T), 1.4 s with ten communities. The
    // reason for awaiting the key group is about RECEIVING (below), never about drawing a row.
    // Settled into a value at once, so a chain that fails while the salon listing is still on the
    // wire is HELD, not reported as an unhandled rejection; it is rethrown below where it is read.
    const keyGroupJoined = joinCommunityKeyGroup(ctx, workspaceId, session).then(
      () => ({ failed: false as const }),
      (error: unknown) => ({ failed: true as const, error })
    );

    let channels: ChannelDto[];
    try {
      channels = (await service.listChannels(workspaceId)) as ChannelDto[];
    } catch (error) {
      // SETTLED, NOT RACED (see `executeWorkspaceLoadAttempt`): the key-group chain is still this
      // attempt's, and a retry must not start beside it.
      const join = await keyGroupJoined;
      if (join.failed) {
        ctx.log(
          `[WORKSPACE-LOAD] key group of ${workspaceId} also ended in failure: ${String(join.error)}`
        );
      }
      throw error;
    }
    assertListingSession(session, `the salons of ${workspaceId}`);

    // THE ROWS ARE DRAWN ON THE SALON LISTING'S ANSWER. A send typed into one of them waits for the
    // ENTRY below (`salonSendGate`), so drawing a row early offers nothing the gate does not hold.
    const salons: { actualId: string; isPrivate: boolean; viewerHasAccess: boolean }[] = [];
    for (const channel of channels) {
      const actualId = channel.id || channel._id;
      if (!actualId) continue;

      // A SALON DELETED, LEFT OR TAKEN FROM THIS MEMBER AFTER THE QUESTION is in an answer that
      // predates it: no row, no conversation, no entry - the live removal is the newer fact.
      if (ledger.learnedSince(`channel_${actualId}`, epochAtRequest) === 'gone') {
        console.debug(
          `[WORKSPACE-LOAD] salon channel_${actualId} not restored: listed by the server, but removed on this device after the listing was asked (tick ${epochAtRequest})`
        );
        continue;
      }

      const isPrivate = channel.visibility === 'private';
      const viewerHasAccess = channel.viewerHasAccess !== false;
      salons.push({ actualId, isPrivate, viewerHasAccess });

      // Which group a salon's seeds travel on is the one fact the send path cannot derive: a
      // channel id alone reaches every send site, and the seal needs the roster the seed is
      // sealed to - the community for a public salon, the salon itself for a private one. A pure
      // map write, so it goes with the row: a seed repair asked from the row needs it.
      registerChannelWorkspace(actualId, workspaceId, isPrivate);

      const channelConversationId = `channel_${actualId}`;
      if (!validChannelConversationIds.includes(channelConversationId)) {
        validChannelConversationIds.push(channelConversationId);
      }
      // THE LISTING'S OWN WRITE, not a live fact: it goes past the ledger.
      upsertChannelRow(sidebarWorkspace.id, {
        id: channelConversationId,
        name: channel.name,
        isPrivate,
        hasAccess: viewerHasAccess,
        canWrite: channel.viewerCanWrite !== false,
      });

      // AN UNJOINED SALON GETS NO CONVERSATION, and that is the point: a conversation row is what
      // every read path keys off, and this viewer may not read it. The sidebar row exists so the
      // join is reachable, and the join is what turns it into a conversation.
      if (!viewerHasAccess) continue;

      ctx.conversations.set(
        channelConversationId,
        buildConversationRow({
          id: channelConversationId,
          lifecycle: 'active',
          identity: { contactName: channelConversationId, displayName: channel.name },
          existing: ctx.conversations.get(channelConversationId),
        })
      );
    }
    // EVERY SALON THE LISTING NAMED IS REGISTERED: from here a salon it did not name, met on the
    // community's key group, is not one this viewer may read as public (`markCommunityListed`).
    markCommunityListed(workspaceId);

    // THE ENTRY WAITS FOR THE KEY GROUP, as it always did: a private salon's own group and the send
    // gate both come after the community's group is registered - and so after MLS is READY, which
    // the key-group chain awaited.
    const join = await keyGroupJoined;
    if (join.failed) throw join.error;
    assertListingSession(session, `the salon entries of ${workspaceId}`);
    for (const { actualId, isPrivate, viewerHasAccess } of salons) {
      // A PRIVATE SALON HAS ITS OWN GROUP, and this is one of the three moments this device
      // enters it. This is the only one that meets a salon the viewer may merely SEE, so it is the
      // only one that passes anything but `true` - see `enterPrivateSalonGroup` for why declining
      // has to be as loud as entering.
      await enterPrivateSalonGroup(service, workspaceId, actualId, {
        isPrivate,
        viewerHasAccess,
        ensureMls: ctx.ensureMls,
        log: ctx.log,
      }).catch((e: unknown) =>
        leaveKeyGroupToMainTab(e, `the salon ${actualId}`, { gesture: false, log: ctx.log })
      );
      assertListingSession(session, `the salon ${actualId}`);
      // ENTERED: a send typed into this salon before the walk reached it goes now (`salonSendGate`).
      openSalonSendGate(actualId);
    }
  }

  /**
   * Joins the community's Graine key-distribution group once MLS is READY. A context with no MLS
   * at all (a background caller) joins nothing.
   *
   * Done in the listing, and AWAITED before any salon is entered, for a reason beyond tidiness: it is
   * what registers the group id locally, and until it is registered a seed frame arriving on that
   * group is treated as an unknown conversation and answered with a welcome_request nobody will ever
   * send. Awaiting closes that window instead of leaving one spurious recovery per community per
   * start.
   *
   * WAITS FOR `whenMlsReady`, NOT `ensureMls` (F2): the listing may start on the access token, before
   * the login has initialised MLS, and `ensureMls()` would hand back a client nobody has opened. A
   * sign-out while it waits rejects it (`MlsSessionEndedError`), and the listing stops there.
   *
   * Never fatal to the load: a community that fails to prepare must still appear in the sidebar, and
   * its salons then refuse to SEND with a named cause rather than the whole community vanishing. The
   * failure is logged with its cause by `ensureCommunityDistributionGroup`, which is all a
   * best-effort path leaves behind.
   */
  async function joinCommunityKeyGroup(
    ctx: ChannelWorkspaceContext,
    workspaceId: string,
    session: number
  ): Promise<void> {
    if (!ctx.ensureMls) return;
    await whenMlsReady();
    assertListingSession(session, `the key group of ${workspaceId}`);
    const mls = await ctx.ensureMls();
    assertListingSession(session, `the key group of ${workspaceId}`);
    await ensureCommunityDistributionGroup(mls, service, workspaceId, ctx.log).catch((e: unknown) =>
      leaveKeyGroupToMainTab(e, `the key group of ${workspaceId}`, {
        gesture: false,
        log: ctx.log,
      })
    );
  }

  /**
   * Deletes the stored page (F4) of every salon this listing does not name. The loop over the
   * conversations cannot reach them: a salon gets a conversation only once it is listed in this
   * process, so the page of a salon the member lost, or that was deleted, while the app was closed
   * would stay at rest for ever. The boot used to erase every salon's rows, which was the only sweep
   * before F4 kept them. A salon created or heard of on this device after the request is spared, as
   * above.
   *
   * Never fatal: a store that cannot be read leaves the sweep to the next listing, said in the log.
   */
  async function sweepStoredSalonPages(
    ctx: ChannelWorkspaceContext,
    validChannelConversationIds: string[],
    epochAtRequest: number,
    session: number
  ): Promise<void> {
    if (!ctx.storedSalonPageIds || !ctx.deleteConversation) return;
    let stored: string[];
    try {
      stored = await ctx.storedSalonPageIds();
    } catch (error) {
      ctx.log(
        `[WORKSPACE-LOAD] stored salon pages not swept - the next listing does: ${String(error)}`
      );
      return;
    }
    const listed = new SvelteSet(validChannelConversationIds);
    const orphans = stored.filter(
      (id) => !listed.has(id) && !keepUnlisted('stored salon page', id, id, epochAtRequest)
    );
    if (orphans.length === 0) return;
    assertListingSession(session, 'sweeping the stored salon pages');
    for (const id of orphans) {
      await ctx
        .deleteConversation(id)
        .catch((error: unknown) =>
          ctx.log(`[WORKSPACE-LOAD] stored page of ${id} not deleted: ${String(error)}`)
        );
    }
  }

  /**
   * THE ONE DECISION ON SOMETHING A LISTING DID NOT NAME, and the line that says which way it went.
   *
   * NEWER THAN THE QUESTION IS NOT ABSENT FROM THE ANSWER: kept when this device created it or heard
   * of it live after the listing was asked (`ledger`), deleted otherwise. A deletion is said per id
   * at `warn`, with both halves of its reason, because it is the visible end of a removal this device
   * did not hear live - and a salon pruned in silence is how a member lost one they had just been
   * given (dev, 2026-10-26). A keep is said per id at `debug`.
   */
  function keepUnlisted(kind: string, id: string, key: string, epochAtRequest: number): boolean {
    if (ledger.learnedSince(key, epochAtRequest) === 'present') {
      console.debug(
        `[WORKSPACE-LOAD] kept ${kind} ${id}: not listed by the server, but created or heard of on this device after the listing was asked (tick ${epochAtRequest})`
      );
      return true;
    }
    console.warn(
      `[WORKSPACE-LOAD] pruned ${kind} ${id}: not listed by the server, and neither created nor heard of on this device after the listing was asked (tick ${epochAtRequest})`
    );
    return false;
  }

  /**
   * What a load ends with: the salons and communities the listing did not name are deleted, except
   * those created or heard of on this device after it was requested.
   */
  async function pruneAfterLoad(
    ctx: ChannelWorkspaceContext,
    epochAtRequest: number,
    validChannelConversationIds: string[],
    validWorkspaceSlugs: Set<string>,
    session: number,
    landingAtRequest: number
  ): Promise<void> {
    // NEWER THAN THE QUESTION IS NOT ABSENT FROM THE ANSWER. A salon created - or heard of on the
    // socket - while this listing was in flight is missing from it by construction, and deleting it
    // here destroys a salon the user is very probably typing in, or has just been given.
    const learnedPresentAfter = (id: string) =>
      ledger.learnedSince(id, epochAtRequest) === 'present';
    const staleLocalChannelIds = Array.from(ctx.conversations.keys()).filter(
      (id) =>
        isChannelConversationId(id) &&
        !validChannelConversationIds.includes(id) &&
        !keepUnlisted('salon', id, id, epochAtRequest)
    );
    for (const staleId of staleLocalChannelIds) {
      assertListingSession(session, `pruning ${staleId}`);
      ctx.invalidateChannelHistoryCache?.(staleId);
      ctx.conversations.delete(staleId);
      dropChannelRow(staleId);
      if (selectedChannelConversationId === staleId) {
        selectedChannelConversationId = '';
      }
      await ctx
        .deleteConversation?.(staleId)
        .catch((error: unknown) =>
          ctx.log(`[WORKSPACE-LOAD] pruned salon ${staleId} not deleted locally: ${String(error)}`)
        );
    }
    assertListingSession(session, 'pruning the communities');
    await sweepStoredSalonPages(ctx, validChannelConversationIds, epochAtRequest, session);

    // A SALON ROW WITH NO CONVERSATION IS PRUNED TOO. The loop above walks the conversations, and a
    // row drawn from the saved snapshot (F1) has none until a listing names it - so a salon deleted,
    // or closed to this member, since the snapshot was written would stay on the rail for ever.
    // Only in the communities this listing answered for: a community created after it was asked
    // keeps its salons for the same reason it is kept itself.
    channelWorkspaces = channelWorkspaces.map((ws) => {
      if (!validWorkspaceSlugs.has(ws.id)) return ws;
      const channels = ws.channels.filter(
        (c) =>
          validChannelConversationIds.includes(c.id) ||
          keepUnlisted('salon row', c.id, c.id, epochAtRequest)
      );
      return channels.length === ws.channels.length ? ws : { ...ws, channels };
    });

    // A LANDING ON A SALON THIS ANSWER DOES NOT NAME ENDS HERE, when it was published before the
    // question was asked - a saved row tapped before the session (F1) for a salon closed to the
    // member since. The landing would otherwise ask for a second full listing before giving up
    // (`landingRecovery`), and that listing could only repeat this answer. A landing published
    // after the request (a notification for a salon this listing could not know) keeps its refresh.
    const landing = notifNav.pending;
    if (
      landing !== null &&
      isChannelConversationId(landing) &&
      notifNav.landing <= landingAtRequest &&
      !validChannelConversationIds.includes(landing) &&
      !learnedPresentAfter(landing)
    ) {
      ctx.log(
        `[WORKSPACE-LOAD] landing on salon ${landing.slice(0, 16)} abandoned: the listing asked after it does not name it`
      );
      notifNav.clear();
      if (selectedChannelConversationId === landing) selectedChannelConversationId = '';
    }

    // Prune workspaces that no longer exist on the server - EXCEPT the ones that did not exist
    // when this listing was requested (created, or heard of on the socket, since), which are missing
    // from it for a reason that is not deletion.
    //
    // THE INVALIDATION OF THE SAVED LIST IS THIS LINE: a community the member lost since the
    // snapshot was written leaves here, on the server's answer, and the snapshot is rewritten from
    // what is left (the effect on `channelWorkspaces`). No clock decides it.
    channelWorkspaces = channelWorkspaces.filter(
      (ws) =>
        validWorkspaceSlugs.has(ws.id) ||
        keepUnlisted('community', ws.id, communityLedgerKey(ws.id), epochAtRequest)
    );
  }

  /**
   * The human half of a NestJS JSON error envelope, or the body itself when it is not one.
   *
   * PARSING A DOCUMENTED ENVELOPE, not reading prose: `{ statusCode, code, message }` is the shape
   * every service here answers a refusal with, and `message` is the sentence meant for a reader.
   * What this returns is only ever SHOWN - nothing branches on it.
   */
  function readErrorDetail(raw: string): string {
    try {
      const body = JSON.parse(raw) as { message?: string | string[]; error?: string };
      return Array.isArray(body.message)
        ? body.message.join(', ')
        : (body.message ?? body.error ?? raw);
    } catch {
      return raw;
    }
  }

  /**
   * HTTP status, stable refusal `code` and human detail of a failed API call - read off the TYPE.
   *
   * `ChannelService.handleError` builds a {@link ChannelApiError} with the status and the code it
   * has in hand, and this is where they are picked up again. What it replaced took a STRING: it
   * re-parsed the body for the status, and when the body was not JSON it went looking for any
   * three-digit number in the sentence. That found the 502 in `API Error 502` and it would equally
   * have found the year in a date, the count in `403 members`, or nothing at all in a refusal
   * phrased without digits - at which point every caller fell through to its generic arm and told
   * the user the wrong thing about a refusal the server had named precisely.
   *
   * An error that is not one of ours carries no status, and says so by leaving it undefined rather
   * than by having one guessed for it.
   */
  function classifyApiError(error: unknown): {
    status?: number;
    code?: string;
    detail: string | null;
  } {
    if (error instanceof ChannelApiError) {
      return {
        status: error.status,
        code: error.code ?? undefined,
        detail: readErrorDetail(error.message),
      };
    }
    // NO ENVELOPE, NO DETAIL. `readErrorDetail` parses a documented Nest body, and only a refusal
    // this API answered has one. Anything else here is a transport failure or a bug of ours, whose
    // message is English and is not a sentence for a reader - it used to be interpolated straight
    // into `channel_action_error_generic`, so a `TypeError: x is not a function` was shown to a
    // member as the reason their community would not load.
    return { detail: null };
  }

  /**
   * Maps a failed API call to a localized, user-facing message for `action`, surfaces it as an
   * error toast (so users no longer need the debug log to see failures), and returns the same
   * string for `ctx.log`. A 403 is reported as insufficient permissions with the backend reason,
   * distinct from a 401 which is reported as an expired session.
   *
   * THE FIVE ARMS ARE DECIDED BY STATUS AND BY TYPE, never by the sentence. Each used to carry a
   * second list of needles beside its status test - `unauthorized`, `token`, `403`, `forbidden`,
   * `permission`, `already`, `network`, `fetch`, `injoignable` - matched against the status and
   * the detail CONCATENATED, so a refusal that merely mentioned a permission was reported as one
   * and `403` matched anything containing those three digits. It was there because the status was
   * being guessed rather than read; now it is read, and the needles have nothing left to cover.
   *
   * @param action Localized action label (e.g. `m.channel_action_community_image()`).
   * @param error The caught error - a {@link ChannelApiError} from any `ChannelService` call, or
   *   anything else that reached the catch.
   * @param toast When false, skips the toast because the caller surfaces the error itself. Defaults to true.
   */
  function toUiActionError(action: string, error: unknown, toast = true): string {
    // THE USER IS SIGNING OUT: the action stopped because of what they chose, so no error toast is
    // raised over the sign-out. The session line is still returned, for the log and an inline field.
    if (error instanceof SignOutInProgressError) return m.channel_action_error_session({ action });
    const { status, code, detail } = classifyApiError(error);

    // A typed refusal is answered from its code, which is more precise than any status.
    const coded = describeCommunityRefusal(code);
    if (coded) {
      if (toast) showToast(coded, 'error');
      return coded;
    }

    let message: string;
    if (status === 401 || error instanceof SessionExpiredError) {
      message = m.channel_action_error_session({ action });
    } else if (status === 403) {
      // `detail` is non-null on every path that reaches here: a status comes only from a
      // `ChannelApiError`, and that is the branch above which reads the envelope.
      message = m.channel_action_error_permission({ action, detail: detail ?? '' });
    } else if (status === 409) {
      message = m.channel_action_error_conflict({ action });
    } else if (error instanceof GraineSealUnavailableError) {
      // Nothing was sent: this device holds no key for the scope yet (join not landed, session not
      // wired). Said as a TYPE at the throw, so it no longer lands in the nameless arm below.
      message = sealUnavailableMessage(error.reason);
    } else if (isRetryableLoadError(error)) {
      // ONE PREDICATE, NOT TWO. "Worth retrying" and "say it is the network" are the same
      // question - the server did not decide anything - and they were two hand-kept lists that
      // agreed only while someone kept them agreeing. The load path already had to be right about
      // it, so the toast reads its answer instead of re-deriving one.
      message = m.channel_action_error_network({ action });
    } else if (detail) {
      message = m.channel_action_error_generic({ action, detail });
    } else {
      // The server said nothing we can quote, so the sentence says only what was attempted.
      // THE CAUSE IS LOGGED HERE, because the sentence cannot carry it: this arm is a non-API
      // error, and without this line a failed send left nothing to read it from.
      console.error(`[CHANNEL] ${action}: unclassified failure`, error);
      message = m.channel_action_error_unknown({ action });
    }

    if (toast) showToast(message, 'error');
    return message;
  }

  // ---------- Workspace helpers ----------

  /** Converts a workspace display name into a URL-safe slug (lowercase, ASCII, hyphens, max 48 chars). */
  function slugifyWorkspace(name: string): string {
    return slugify(name, 48);
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

  /**
   * The sidebar id a community DTO is drawn under: its slug, else one derived from its id, else
   * `null` when it carries neither (and is then drawn under a random id nothing else can name).
   */
  function workspaceSlugOf(workspace: WorkspaceDto): string | null {
    const workspaceId = workspace.id ?? workspace._id;
    return (
      workspace.slug?.trim().toLowerCase() || (workspaceId ? `workspace-${workspaceId}` : null)
    );
  }

  /** Inserts a new workspace sidebar entry or updates the matching one if it already exists. Returns the sidebar entry. */
  function upsertWorkspaceFromDto(workspace: WorkspaceDto): ChannelSidebarWorkspace {
    const workspaceId = workspace.id ?? workspace._id;
    const workspaceSlug =
      workspaceSlugOf(workspace) ?? `workspace-${crypto.randomUUID().slice(0, 8)}`;
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
      if (workspace.viewerCanManageChannels !== undefined)
        existing.viewerCanManageChannels = workspace.viewerCanManageChannels;
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
      viewerCanManageChannels: workspace.viewerCanManageChannels ?? false,
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
   *
   * This is the LISTING's write. Anything else that draws a salon - a creation here, an event heard
   * on the socket - goes through {@link addChannelToWorkspace}, which also dates it for the prune.
   */
  function upsertChannelRow(workspaceSlug: string, channel: ChannelSidebarItem) {
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

  /**
   * Draws a salon this device CREATED or HEARD OF LIVE (`channel.member.joined`), and records it as
   * present in the ledger - THE ONE PLACE every live insertion of a salon row goes through, so a
   * listing already in flight cannot prune it (it was absent from an answer that predates it). The
   * listing's own rows go through {@link upsertChannelRow} and date nothing.
   */
  function addChannelToWorkspace(workspaceSlug: string, channel: ChannelSidebarItem) {
    ledger.present(channel.id);
    upsertChannelRow(workspaceSlug, channel);
  }

  /**
   * Takes a salon off the rail because this device LEARNED LIVE that it is gone - deleted, left, or
   * taken from this member - and records that in the ledger, so a listing already in flight cannot
   * draw it back from an answer that predates the removal. THE ONE PLACE every live removal of a
   * salon row goes through; the prune's own removal is {@link dropChannelRow}.
   */
  function removeChannelFromWorkspaces(channelConversationId: string) {
    ledger.gone(channelConversationId);
    dropChannelRow(channelConversationId);
  }

  /** Removes the given channel conversation ID from every workspace in the sidebar, dating nothing. */
  function dropChannelRow(channelConversationId: string) {
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
      // HEARD OF LIVE: the event is newer than any listing in flight, as for its salon.
      ledger.present(communityLedgerKey(existing.id));
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
    // A COMMUNITY HEARD OF LIVE while a listing is in flight is absent from its answer; this is what
    // stops that listing from deleting the placeholder before the join's own listing names it.
    ledger.present(communityLedgerKey(created.id));
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
    ensureMls?: () => IMlsService | Promise<IMlsService>,
    log: (message: string) => void = () => {}
  ): Promise<void> {
    if (!channelId || !workspaceId) return;
    registerChannelWorkspace(channelId, workspaceId, isPrivate);
    // THE ENTRY IS IN FLIGHT FROM HERE: the event drew the salon's conversation before this call,
    // so a send typed during the joins below waits for them instead of being refused by a listing
    // that settled before the salon existed (`salonSendGate`). Ended in the `finally`, opened or not.
    const entryToken = beginSalonEntry();
    try {
      await enterJoinedChannel(channelId, workspaceId, isPrivate, ensureMls, log);
      openSalonSendGate(channelId);
    } finally {
      settleSalonEntry(entryToken);
    }
  }

  /** The joins {@link registerJoinedChannel} owes a salon entered in-session. */
  async function enterJoinedChannel(
    channelId: string,
    workspaceId: string,
    isPrivate: boolean,
    ensureMls: (() => IMlsService | Promise<IMlsService>) | undefined,
    log: (message: string) => void
  ): Promise<void> {
    // A PUBLIC SALON'S SEEDS TRAVEL ON THE COMMUNITY'S GROUP, AND THIS IS WHERE THIS DEVICE ENTERS
    // IT IN-SESSION. The startup walk does three things per community and this path did two: it
    // mapped the channel and it entered a PRIVATE salon's own group. Nothing entered the
    // community's, because `enterPrivateSalonGroup` returns early for a public salon on the
    // premise - true only at startup - that "a different call already entered" it.
    //
    // Measured on the local estate 2026-09-21. The peer was invited, its community appeared in its
    // sidebar and `#general` opened; the server then logged, for the seed the owner distributed
    // seconds later, `[SEND] No message queued after validation - recipients=0 - the group named
    // no other device`. The delivery roster held one device until the peer's app was RELOADED, at
    // which point the startup walk joined in about a second. So every seed minted in that window
    // reached everyone except the person who had just been added, and their salon read
    // `nouveau message` for all of them - the state lasting until they next restarted the app.
    //
    // A PRIVATE SALON TAKES BOTH, and that is not a redundancy: its own seeds travel on its own
    // group, and the community's still carries every public salon of the same community. The join
    // itself is idempotent and coalesced per scope (`ensureDistributionGroupFor`), so a second
    // channel joined in the same session costs one shared promise and no second external commit.
    // A follower tab may enter neither group: said once to the member, and the join goes on without.
    try {
      await enterJoinedChannelGroups(channelId, workspaceId, isPrivate, ensureMls, log);
    } catch (e) {
      leaveKeyGroupToMainTab(e, `the salon ${channelId}`, { gesture: true });
    }
  }

  /** The two groups {@link enterJoinedChannel} enters, in order. */
  async function enterJoinedChannelGroups(
    channelId: string,
    workspaceId: string,
    isPrivate: boolean,
    ensureMls: (() => IMlsService | Promise<IMlsService>) | undefined,
    log: (message: string) => void
  ): Promise<void> {
    if (ensureMls) {
      const mls = await ensureMls();
      await ensureCommunityDistributionGroup(mls, service, workspaceId, log);
    }

    // A PRIVATE SALON JOINED IN-SESSION NEEDS ITS GROUP BEFORE THE FIRST SEND, exactly as one
    // loaded at startup does, and nothing else would fetch it until the next full reload - the
    // same window this function was written to close for the channel-to-community map.
    //
    // THE LOG IS A PARAMETER BECAUSE IT USED TO BE `console.info`. This is the one of the three
    // entries with no `ChannelWorkspaceContext` to hand, and reaching for the console meant a salon
    // joined in-session left nothing in the log every other GRAINE line lands in - including the
    // declined-salon line a stale-tree diagnosis reads.
    await enterPrivateSalonGroup(service, workspaceId, channelId, {
      isPrivate,
      // Having just joined IS the access; nothing here can be a salon the viewer merely sees.
      viewerHasAccess: true,
      ensureMls,
      log,
    });
  }

  // ---------- API operations ----------

  /**
   * Asks the server for every salon's unread count and applies it - after a community load, after
   * this account cleared a community on another device (`channel.unread.cleared`), and to put the
   * truth back when a clear from here was refused. One request whatever the number of salons.
   */
  function refreshSalonUnread(ctx: ChannelWorkspaceContext, reason: string): Promise<void> {
    return reconcileSalonUnreadFromServer({
      conversations: ctx.conversations,
      selectedId: ctx.getSelectedConversationId?.() ?? null,
      userId: currentUserId() ?? '',
      fetchCounts: () => service.listUnreadCounts(),
      settleOwedMarks: () =>
        flushSalonReadMarks(currentUserId() ?? '', (id, at, serverAt) =>
          service.advanceReadMark(id, at, serverAt)
        ),
      log: ctx.log,
      reason,
    });
  }

  /**
   * The salons of a community whose badge "Marquer tout comme lu" would clear: the ones this member
   * may read (`hasAccess !== false`) - an administrator's row for a private salon they only SEE has
   * no count to clear, and the server skips it too.
   */
  function readableSalonKeys(workspaceSlug: string): string[] {
    const workspace = channelWorkspaces.find((ws) => ws.id === workspaceSlug);
    return (workspace?.channels ?? []).filter((c) => c.hasAccess !== false).map((c) => c.id);
  }

  /**
   * "Marquer tout comme lu" on a community (long press on its rail icon, or right click): every
   * salon's badge goes at once on this device, then ONE request clears the same salons on the
   * server, which tells this account's other devices.
   *
   * WHAT IT DOES NOT DO IS THE POINT: no read mark moves, so no "Lu par" head appears under anybody's
   * message - the member cleared a badge, they did not read the salon (wiki: chat.md, "Mark a whole
   * community as read"). Opening a salon afterwards sends the ordinary receipt, because that IS
   * reading it.
   *
   * Cleared up to {@link communityUnreadUpTo}: the newest instant the screen counted, on the server's
   * clock, so a message posted while the menu was open stays unread. A refusal is a toast and a
   * re-read of the server's counts, which puts back exactly what the server still holds.
   */
  async function markCommunityRead(workspaceSlug: string, ctx: ChannelWorkspaceContext) {
    const workspace = channelWorkspaces.find((ws) => ws.id === workspaceSlug);
    const workspaceDbId = workspace?.workspaceDbId;
    if (!workspaceDbId) {
      ctx.log(`[CHANNEL_CLEAR] community ${workspaceSlug} has no server id yet - nothing sent`);
      return;
    }
    const keys = readableSalonKeys(workspaceSlug);
    const upTo = communityUnreadUpTo(ctx.conversations, keys);
    if (upTo <= 0) {
      ctx.log(
        `[CHANNEL_CLEAR] community ${workspaceDbId.slice(0, 8)}: nothing counted, nothing sent`
      );
      return;
    }
    const changed = clearSalonUnreadLocally(ctx.conversations, keys, upTo, currentUserId() ?? '');
    ctx.log(
      `[CHANNEL_CLEAR] community ${workspaceDbId.slice(0, 8)}: ${keys.length} salon(s), ${changed.length} badge(s) cleared here, upTo=${upTo}`
    );
    try {
      await service.clearWorkspaceUnread(workspaceDbId, upTo);
    } catch (error) {
      ctx.log(toUiActionError(m.channel_action_community_mark_read(), error));
      await refreshSalonUnread(ctx, 'community clear refused');
    }
  }

  /**
   * Makes `owner` the account the list belongs to. A list held for ANOTHER account is emptied first:
   * a sign-in that did not go through a sign-out (a refresh naming someone else) must never show the
   * previous account's communities while its own listing runs.
   */
  function adoptListOwner(owner: string | null, log: (msg: string) => void): void {
    if (workspacesOwner !== null && workspacesOwner !== owner) {
      log("[WORKSPACE-SNAPSHOT] the list on screen was another account's - emptied before listing");
      channelWorkspaces = [];
      selectedChannelConversationId = '';
      workspacesConfirmed = false;
    }
    workspacesOwner = owner;
  }

  /**
   * Draws the community list this account was last shown, from the device, before any session or
   * network (F1). Called once at boot by the app shell with the account saved on the device.
   *
   * Does nothing when a list is already in memory (a listing got there first) or when the account
   * has no snapshot. The list it draws is NOT confirmed: the first listing of the session replaces
   * it through the same upsert-and-prune path, and the sidebar shows it as being refreshed until
   * then. Logged once, here and when the listing answers.
   */
  function hydrateFromSnapshot(userId: string | null, log: (msg: string) => void): void {
    if (!userId) return;
    if (channelWorkspaces.length > 0) {
      log('[WORKSPACE-SNAPSHOT] not drawn: a community list is already in memory');
      return;
    }
    const saved = readWorkspaceSnapshot(userId);
    if (saved === null) {
      log('[WORKSPACE-SNAPSHOT] no saved community list for this account - the listing draws it');
      return;
    }
    channelWorkspaces = saved;
    workspacesOwner = userId;
    workspacesConfirmed = false;
    const salons = saved.reduce((sum, ws) => sum + ws.channels.length, 0);
    log(
      `[WORKSPACE-SNAPSHOT] drew ${saved.length} community(ies) and ${salons} salon(s) saved by the last listing - shown as being refreshed until this session's listing answers`
    );
  }

  /**
   * The account signed out: its community list leaves the screen and the memory, and every wait
   * started for it ends.
   *
   * THE SESSION BOUNDARY IS DRAWN HERE TOO (`resetSalonSendGate`), because a listing now starts on
   * the access token (F2), before any live session exists - and a sign-out with no live session (the
   * PIN gate, a login still decrypting) runs no teardown, so the listing would otherwise survive into
   * the next account's session. Bumping the generation stops it at its next write, and abandoning
   * the MLS waiters wakes the one waiting for a key group that will never come.
   */
  function forgetAccount(log: (msg: string) => void): void {
    resetSalonSendGate();
    const abandoned = abandonMlsReadyWaiters('signed out');
    if (abandoned > 0) log(`[WORKSPACE-LOAD] signed out: ${abandoned} key-group wait(s) abandoned`);
    if (channelWorkspaces.length > 0) {
      log(`[WORKSPACE-SNAPSHOT] signed out: ${channelWorkspaces.length} community(ies) forgotten`);
    }
    workspacesOwner = null;
    workspacesConfirmed = false;
    lastSnapshotText = '';
    channelWorkspaces = [];
    selectedChannelConversationId = '';
  }

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
   *
   * A LISTING BELONGS TO ITS SESSION. One still running when its account signs out stops at its
   * next write (`assertListingSession`) and does NOT hold the flag against the next account: the
   * next session's call supersedes it, and resolves to false only against a listing of its own.
   * The stale one resolves to false and records no error - neither is the next session's to read.
   */
  async function loadChannelWorkspacesFromBackend(
    ctx: ChannelWorkspaceContext,
    origin: ListingOrigin = 'direct'
  ): Promise<boolean> {
    if (isLoadingWorkspaces) {
      if (isCurrentSalonSession(activeListingSession)) return false;
      ctx.log(
        '[WORKSPACE-LOAD] the listing in flight belongs to a session that signed out - superseded'
      );
    }
    adoptListOwner(currentUserId(), ctx.log);
    isLoadingWorkspaces = true;
    workspacesLoadError = null;
    lastGiveUpUnreachable = false;
    activeListingOrigin = origin;
    reconnectRetryEarned = false;
    // A salon send waiting for its salon to load waits for THIS listing; its end is what refuses
    // the ones it did not enter (`salonSendGate`). Synchronous with the flag, so no await separates
    // the guard from the count. The token is also this listing's SESSION.
    const listingToken = beginSalonListing();
    const listingId = ++activeListing;
    activeListingSession = listingToken;

    // N DELAYS IS N+1 ATTEMPTS, and the count is named once here rather than being spelt as
    // `<= length` at the loop and `length + 1` in the log. `<=` against a length reads as an
    // off-by-one wherever it appears - to a reader and to an analyser alike - and being able to
    // prove this one was guarded is not the same as it being legible.
    const attemptCount = WORKSPACE_LOAD_RETRY_DELAYS.length + 1;

    try {
      for (let attempt = 0; attempt < attemptCount; attempt++) {
        try {
          listingAttemptInFlight = true;
          try {
            await executeWorkspaceLoadAttempt(ctx, listingToken);
          } finally {
            listingAttemptInFlight = false;
          }
          workspacesLoadError = null;
          ctx.log(`[WORKSPACE-LOAD] communities/channels loaded (attempt ${attempt + 1})`);
          if (!workspacesConfirmed) {
            workspacesConfirmed = true;
            ctx.log(
              `[WORKSPACE-SNAPSHOT] the list on screen is the server's now (${channelWorkspaces.length} community(ies))`
            );
          }
          // THE SALONS EXIST NOW, and what is unread in them is the server's to say: the live tally
          // this device keeps is empty after any reload. See `salonUnread.ts`.
          // NOT awaited: this runs under `isLoadingWorkspaces`, and a slow answer must not make
          // every other load refuse.
          void refreshSalonUnread(ctx, 'communities loaded');
          return true;
        } catch (error) {
          // NOT A FAILURE OF THIS SESSION'S LIST: the account signed out under it. Nothing to retry
          // and nothing to record - `workspacesLoadError` is the next session's to read.
          // A real failure after the sign-out (a 401 once the token is gone) is the same case.
          if (
            error instanceof ListingOutlivedSessionError ||
            !isCurrentSalonSession(listingToken)
          ) {
            ctx.log(
              `[WORKSPACE-LOAD] listing of a previous session ended (${String(error)}): nothing written, no failure recorded`
            );
            return false;
          }
          ctx.log(
            `[WORKSPACE-LOAD] attempt ${attempt + 1}/${attemptCount} failed: ${String(error)}`
          );

          // ONE QUESTION, ASKED ONCE. The 401/403 test that stood beside this call was not a
          // second rule but a patch on the first one: while retryability was decided by hunting
          // words in the body, a refusal whose text happened to say `network` was retried, so the
          // two statuses that hurt most to retry had to be named again here. `isRetryableLoadError`
          // now reads the status off the type, and 401 and 403 are simply not 5xx.
          const isFatal = !isRetryableLoadError(error);

          // THE DELAY IS ALSO THE ANSWER TO "IS THERE ANOTHER ATTEMPT", so it is read ONCE.
          // `isLastAttempt` used to be a second derivation from the same array length, and the
          // two were kept in agreement only by both being written correctly - which is the shape
          // that eventually disagrees. Reading the delay first makes the bound a fact rather than
          // an arithmetic claim: N delays is N+1 attempts, and the attempt with no delay after it
          // is the last one. It is also the only form a reader - or a static analyser - can see
          // is in bounds, the previous one having been flagged as an out-of-range index it could
          // not prove was guarded.
          const delay: number | undefined = WORKSPACE_LOAD_RETRY_DELAYS[attempt];

          if (isFatal || delay === undefined) {
            workspacesLoadError = toUiActionError(m.channel_action_community_load(), error, false);
            lastGiveUpUnreachable = isTransportFailure(error);
            ctx.log(
              `[WORKSPACE-LOAD] giving up (${isFatal ? 'non-retryable' : 'retries exhausted'}, ${lastGiveUpUnreachable ? 'no answer - the next reconnect lists again, held salon sends keep waiting' : 'answered'}) - existing community list preserved: ${workspacesLoadError}`
            );
            return true;
          }

          ctx.log(`[WORKSPACE-LOAD] retryable failure - next attempt in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      // Unreachable: the final attempt always returns from the catch above.
      return true;
    } finally {
      endListing(ctx, listingId, listingToken);
    }
  }

  /**
   * The end of the listing `listingId` of session `listingToken`: drops the in-flight flag, starts
   * the reload a join owed it, and settles the send gate - each only if it is still this listing's
   * to do. A listing superseded by the next session's touches nothing; one whose session merely
   * ended drops the flag and the leaving account's owed reload.
   */
  function endListing(ctx: ChannelWorkspaceContext, listingId: number, listingToken: number): void {
    if (listingId !== activeListing) {
      ctx.log(
        '[WORKSPACE-LOAD] a superseded listing of a previous session ended - the flag is not its own'
      );
      return;
    }
    isLoadingWorkspaces = false;
    if (!isCurrentSalonSession(listingToken)) {
      if (joinedCommunityReloadOwed) {
        ctx.log("[WORKSPACE-LOAD] reload owed to a join dropped: that join's session signed out");
      }
      joinedCommunityReloadOwed = false;
      owedRetry = null;
      reconnectRetryEarned = false;
      return;
    }
    // READ BEFORE THE OWED RELOAD BEGINS: its first statement clears `workspacesLoadError`, and a
    // listing that gave up would otherwise be recorded as one that answered.
    const listingOutcome: SettledListing =
      workspacesLoadError === null ? 'loaded' : lastGiveUpUnreachable ? 'unreachable' : 'failed';
    // A join that arrived while THIS listing was in flight is not in its answer, so it is owed one
    // more. Run here, after the flag drops, because that is the one moment a second load is legal.
    // A trigger that arrived while it ran is owed one more only if it gave up: a listing that
    // answered has nothing left to retry. That owed listing IS this give-up's one reconnect retry.
    const gaveUp = listingOutcome !== 'loaded';
    const retryTrigger = gaveUp ? owedRetry : null;
    reconnectRetryEarned = gaveUp && activeListingOrigin !== 'reconnect' && retryTrigger === null;
    const owedJoin = joinedCommunityReloadOwed;
    joinedCommunityReloadOwed = false;
    owedRetry = null;
    if (retryTrigger !== null) {
      ctx.log(
        `[WORKSPACE-LOAD] ${retryTrigger} came during a listing that gave up - listing again`
      );
      void loadChannelWorkspacesFromBackend(ctx, retryTrigger);
    } else if (owedJoin) {
      void loadChannelWorkspacesFromBackend(ctx);
    }
    // AFTER the owed reload has begun (synchronously, above): a send waiting for a salon that
    // reload may enter keeps waiting for it instead of being refused by this one's end.
    settleSalonListing(listingToken, listingOutcome);
  }

  /**
   * Connectivity came back (`connectivity.onReconnect`: the browser's `online` event, or the server
   * answering again after a transport failure) or the app returned to the foreground: a listing that
   * GAVE UP is listed again, and the salon sends it held are released or refused by that one.
   *
   * WHY THE RECONNECT AND NOT ONLY `online`. The Mi 9T (`v1.2.7-alpha.1`, 2026-10-14) started
   * offline; the `online` event's listing failed in transport and gave up, and no second `online`
   * ever came - the phone stayed online. The reconnect is the PROOF the link works again.
   *
   * BOUNDED, because a reconnect is any answer after a transport failure: ONE reconnect retry per
   * give-up ({@link reconnectRetryEarned}), none for the give-up of a reconnect's own listing, and
   * none owed for a reconnect that may be the listing's own request answering
   * ({@link listingAttemptInFlight}). An endpoint that keeps failing therefore stops after one
   * retry and waits for the foreground - the member's own return, which always lists again.
   *
   * A listing in flight is not doubled: the trigger is OWED to it, and taken up by
   * {@link endListing} if that listing gives up.
   */
  function retryFailedListing(ctx: ChannelWorkspaceContext, trigger: ListingRetryTrigger): void {
    if (isLoadingWorkspaces) {
      if (trigger === 'reconnect' && activeListingOrigin === 'reconnect') {
        ctx.log("[WORKSPACE-LOAD] reconnect during a reconnect's own listing - nothing owed");
        return;
      }
      if (trigger === 'reconnect' && listingAttemptInFlight) {
        ctx.log(
          "[WORKSPACE-LOAD] reconnect while the listing's own request was on the wire - may be its own answer, nothing owed"
        );
        return;
      }
      owedRetry = trigger;
      ctx.log(`[WORKSPACE-LOAD] ${trigger} during a listing - one more is owed if it gives up`);
      return;
    }
    if (workspacesLoadError === null) return;
    if (trigger === 'reconnect') {
      if (!reconnectRetryEarned) {
        ctx.log(
          '[WORKSPACE-LOAD] reconnect - NOT listing again: this give-up already had its one reconnect retry; the foreground lists again'
        );
        return;
      }
      reconnectRetryEarned = false;
    }
    ctx.log(`[WORKSPACE-LOAD] ${trigger} - listing the communities again (the last one gave up)`);
    void loadChannelWorkspacesFromBackend(ctx, trigger);
  }

  /**
   * True when no community of this device matches the event: the first sight of a community, which
   * is what a join in-session looks like from the receiving end.
   */
  function isCommunityUnknownToEvent(event: { workspaceId?: string; workspaceSlug?: string }) {
    const slug = event.workspaceSlug?.trim().toLowerCase();
    return !channelWorkspaces.some(
      (workspace) =>
        (event.workspaceId && workspace.workspaceDbId === event.workspaceId) ||
        (slug && workspace.id === slug)
    );
  }

  /**
   * Hydrates a community this device has just JOINED, through the one path a reload uses.
   *
   * WHY IT EXISTS (measured 2026-10-08, UNR-11): accepting an invitation link makes the SERVER
   * publish ONE `channel.member.joined`, for one representative public salon, whatever the
   * community holds. Handled alone it registered that salon and nothing else, so the sidebar listed
   * one salon and every message in the others hit `Message received for an unknown channel` until
   * the next full load. The event names a community, never its roster: the roster is the listing's
   * to say, so the listing runs - once, awaited by nobody, and owed again if one was already in
   * flight (its answer predates the join).
   */
  async function hydrateJoinedCommunity(ctx: ChannelWorkspaceContext): Promise<void> {
    ctx.log('[WORKSPACE-LOAD] community joined in-session - loading its salons');
    const session = currentSalonSession();
    const ran = await loadChannelWorkspacesFromBackend(ctx);
    if (ran) return;
    // A listing that outlived its session also answers false; the join it carried left with it.
    if (!isCurrentSalonSession(session)) {
      ctx.log("[WORKSPACE-LOAD] joined community's reload not owed: its session signed out");
      return;
    }
    joinedCommunityReloadOwed = true;
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
    // Its salons are drawn below through `addChannelToWorkspace`, which dates each of them the same
    // way: the conversation of a default salon used to be pruned by that listing while its row stayed.
    ledger.present(communityLedgerKey(sidebarWorkspace.id));
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
      await ensureCommunityDistributionGroup(mls, service, workspaceId, ctx.log).catch(
        (e: unknown) =>
          leaveKeyGroupToMainTab(e, `the key group of ${workspaceId}`, { gesture: true })
      );
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
          // The community's group was ensured above; a salon of a community just created is entered.
          openSalonSendGate(actualId);

          const channelConversationId = `channel_${actualId}`;
          addChannelToWorkspace(sidebarWorkspace.id, {
            id: channelConversationId,
            name: channel.name,
            isPrivate: channel.visibility === 'private',
          });
          // `messages: []` USED TO BE WRITTEN HERE UNCONDITIONALLY, over a row this same statement
          // had just read for its unread count. Hydrating the workspace emptied a channel the user
          // was reading. The builder preserves what the existing row carries, which is the whole
          // reason the existing row is passed rather than picked apart.
          ctx.conversations.set(
            channelConversationId,
            buildConversationRow({
              id: channelConversationId,
              lifecycle: 'active',
              identity: { contactName: channelConversationId, displayName: channel.name },
              existing: ctx.conversations.get(channelConversationId),
            })
          );
        }
        markCommunityListed(workspaceId);
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
    // Stored as typed: a salon name is a display string, the id is its identity. The server is the
    // authority on what is refused (empty, too long, control characters).
    const normalizedChannelName = nameRaw.trim();
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
      // Same stamp as a community, for the same window and the same prune - dated the moment the
      // server answers, before the awaits below. `addChannelToWorkspace` dates it again on the row.
      ledger.present(channelId);
      registerChannelWorkspace(actualId, workspaceId, isPrivate);

      // The salon was created private, so social-service has already minted its group; this device
      // is the one that initialises the MLS state on it, and it must do so before the first send.
      // Creating it IS the access.
      await enterPrivateSalonGroup(service, workspaceId, actualId, {
        isPrivate,
        viewerHasAccess: true,
        ensureMls: ctx.ensureMls,
        log: ctx.log,
      }).catch((e: unknown) =>
        leaveKeyGroupToMainTab(e, `the salon ${actualId}`, { gesture: true })
      );
      openSalonSendGate(actualId);

      const sidebarWorkspace = channelWorkspaces.find((w) => w.workspaceDbId === workspaceId);
      if (sidebarWorkspace) {
        addChannelToWorkspace(sidebarWorkspace.id, {
          id: channelId,
          name: normalizedChannelName,
          isPrivate,
        });
      }

      selectedChannelConversationId = channelId;

      ctx.conversations.set(
        channelId,
        buildConversationRow({
          id: channelId,
          lifecycle: 'active',
          identity: { contactName: channelId, displayName: normalizedChannelName },
        })
      );
      await ctx.saveConversation(channelId);
      ctx.selectConversation(channelId);
      ctx.log(`Channel created: ${channelId} (${visibility})`);
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
      // An ordinary invitation names NO role: the server grants the community's base role, whatever
      // it is called there. A role is named only when the inviter picked one above it.
      const backendRoleName =
        roleName === 'admin' ? 'Administrateur' : roleName === 'moderator' ? 'Modérateur' : null;
      // THE PROOF THAT LETS A MEMBER HAND THE NEWCOMER THE PAST (channel-encryption section 25),
      // signed by this device and stored with the membership. Without it the invitation still
      // admits; the newcomer then reads from their arrival on, so a failure is said, not hidden.
      let admissionVoucher: string | undefined;
      if (currentWorkspace?.workspaceDbId) {
        try {
          admissionVoucher = await signDirectAdmission(currentWorkspace.workspaceDbId, memberId);
        } catch (e) {
          console.error(
            `[GRAINE] admission of ${memberId.slice(0, 8)} NOT signed - they will read only from their arrival on: ${String(e)}`
          );
        }
      }
      const invited = await service.inviteToChannel(channelId, {
        targetUserId: memberId,
        ...(backendRoleName ? { roleName: backendRoleName } : {}),
        ...(admissionVoucher ? { admissionVoucher } : {}),
      });

      // WHOEVER ADMITS A NEWCOMER WELCOMES THEM (channel-encryption section 20). This device is
      // online and holds the key group, and the newcomer's phone may be shut: without this, it
      // took every salon push and opened none until the app was next started. Only for a member
      // the server has just CREATED - `alreadyMember` means nothing was granted, so nobody is owed
      // an admission. Not awaited: it is a commit and a Welcome per device, the invitation has
      // already succeeded, and the admission never throws - every outcome is logged.
      const workspaceDbId = currentWorkspace?.workspaceDbId;
      if (invited.alreadyMember !== true && workspaceDbId) {
        void admitInvitedMember(
          workspaceDbId,
          channelId,
          currentChannel?.isPrivate === true,
          memberId,
          ctx.log
        );
      } else if (invited.alreadyMember !== true) {
        ctx.log(
          `[GRAINE] ADMIT ${memberId.slice(0, 8)}: the community of channel ${channelId.slice(0, 8)} is not loaded here - nobody admitted, the newcomer's own load joins it`
        );
      }

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
          // SILENT: the row is opaque to the server, so the sender says it is a notice - it must
          // neither count as unread for the salon's members nor ring their phones.
          await sendEncryptedChannelMessage(
            channelConversationId,
            systemBytes,
            undefined,
            undefined,
            undefined,
            { silent: true }
          );
        } catch (err) {
          console.warn('[Channel Invite] Failed to send system message to channel:', err);
          // Do not block the invitation if the system message fails
        }
      }

      ctx.log(`Member invited to channel (${roleName}): ${memberId}`);
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
    // DATED GONE BEFORE THE FIRST AWAIT, the community and every salon on its rail: a listing in
    // flight answers from before this removal, and would otherwise draw all of it back.
    const doomed = channelWorkspaces.find((ws) => ws.workspaceDbId === workspaceDbId);
    if (doomed) {
      ledger.gone(communityLedgerKey(doomed.id));
      for (const ch of doomed.channels) ledger.gone(ch.id);
    }
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
   * Edits the caller's OWN text message in a salon: applied locally at once, then sealed as a silent
   * encrypted row carrying the SAME instant (WP-OFF-4).
   *
   * Nothing here asks the server anything, because it cannot answer: a salon row is an opaque blob
   * (Graine), so the server does not know the frame is an edit or whose message it names. The
   * ownership check is made here for the menu's sake and AGAIN by every reader on arrival
   * (`applyChannelEdit`), the one that counts since this side can be bypassed.
   *
   * OPTIMISTIC, AND TAKEN BACK ONLY WHEN NOTHING WAS LEFT. An edit made offline is owed to the
   * reconnect (`deliverSalonWrite`) and stays on screen meanwhile; its repeat carries the same row id,
   * which the server answers with the row it holds. It is reverted only when nothing of it left the
   * device (`nothingLeftTheDevice`) - a text the peers will never receive must not stay on this screen
   * as if shared - and never over a later edit.
   */
  async function editChannelMessage(
    channelConversationId: string,
    messageId: string,
    text: string,
    ctx: ChannelWorkspaceContext
  ) {
    const userId = currentUserId();
    const convo = ctx.conversations.get(channelConversationId);
    const target = convo?.messages.find((msg) => msg.id === messageId);
    if (
      !convo ||
      !target ||
      !userId ||
      (target.senderId ?? '').toLowerCase() !== userId.toLowerCase()
    ) {
      ctx.log(`[CHANNEL] edit of ${messageId.slice(0, 8)} not sent - not the author's message`);
      return;
    }
    const editedAt = Date.now();
    const { messages, applied } = applyChannelEdit(
      convo.messages,
      { targetMessageId: messageId, senderId: userId, newContent: text, editedAt },
      ctx.log
    );
    if (!applied) {
      ctx.log(`[CHANNEL] edit of ${messageId.slice(0, 8)} not sent - it changes nothing here`);
      return;
    }
    ctx.conversations.set(channelConversationId, { ...convo, messages });
    const rowId = crypto.randomUUID();
    await deliverSalonWrite(
      `edit:${messageId}`,
      () => sendChannelEdit(channelConversationId, messageId, text, editedAt, rowId),
      (outcome) => {
        if (outcome.kind === 'owed') {
          ctx.log(`[CHANNEL] edit of ${messageId.slice(0, 8)} kept on screen, sent on reconnect`);
          return;
        }
        ctx.invalidateChannelHistoryCache?.(channelConversationId);
        if (outcome.kind === 'sent') return;
        if (nothingLeftTheDevice(outcome.error)) {
          const latest = ctx.conversations.get(channelConversationId);
          const undone = latest
            ? revertChannelEdit(latest.messages, target, { newContent: text, editedAt })
            : null;
          if (latest && undone?.reverted) {
            ctx.conversations.set(channelConversationId, { ...latest, messages: undone.messages });
          }
          ctx.log(
            `[CHANNEL] edit of ${messageId.slice(0, 8)} not sent, ${undone?.reverted ? 'taken back' : 'already superseded - left as is'}`
          );
        } else {
          ctx.log(`[CHANNEL] edit of ${messageId.slice(0, 8)} outcome unknown, kept on screen`);
        }
        ctx.log(toUiActionError(m.channel_action_message_edit(), outcome.error));
      }
    );
  }

  /**
   * Places or takes back the caller's emoji reaction on a channel message.
   *
   * **The reaction IS the message (WP-40).** It is sealed under this device's Graine session and
   * stored by the server as an opaque blob, so the server no longer counts who reacted with what -
   * it used to hold that tally in cleartext, which is content by any honest reading.
   *
   * The local merge comes FIRST and with the same `at` the frame carries, so the pill flips at
   * once and this device's own row, when it comes back, merges to exactly the same state.
   *
   * **OWED WHILE OFFLINE, ROLLED BACK ONLY WHEN NOTHING WAS SENT** (2026-10-06, WP-OFF-4): a reaction
   * made offline keeps its pill and goes on the reconnect, under the same row id and `at`
   * (`deliverSalonWrite`); a later toggle of the same emoji owes the later frame instead. When nothing
   * of it left the device (`nothingLeftTheDevice`: a refusal below 500, a seal this device cannot
   * make), the pill is a claim about a reaction nobody else will ever see, so it is undone - the
   * inverse frame at a LATER `at`, applied locally and never sent. A 5xx or no answer with the link
   * up may have reached peers, and unflipping there would disagree for good with the frame they hold
   * - so it stays.
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
    const rowId = crypto.randomUUID();
    await deliverSalonWrite(
      `reaction:${messageId}:${emoji}`,
      () => sendChannelReaction(channelConversationId, messageId, emoji, at, standing, rowId),
      (outcome) => {
        if (outcome.kind === 'owed') {
          ctx.log(`[CHANNEL] reaction on ${messageId.slice(0, 8)} kept, sent on reconnect`);
          return;
        }
        if (outcome.kind === 'sent') {
          void notifyReactionAuthor(channelConversationId, messageId, emoji, standing, userId, ctx);
          return;
        }
        if (nothingLeftTheDevice(outcome.error)) {
          const undone = applyChannelReactionFrame(
            messageId,
            userId,
            emoji,
            Math.max(Date.now(), at + 1),
            !standing
          );
          ctx.log(`[CHANNEL] reaction not sent, local pill rolled back: ${undone}`);
        } else {
          ctx.log(`[CHANNEL] reaction outcome unknown, local pill kept: the server may hold it`);
        }
        ctx.log(toUiActionError(m.channel_action_message_react(), outcome.error));
      }
    );
  }

  /**
   * NOTIFIES THE AUTHOR, AND NOBODY ELSE, of a reaction placed on their message. The reaction itself
   * is sent silent - a heart must not ring every phone in the community - so this targeted push is
   * the only notification there is. It concerns the person reacted to, and telling a whole channel
   * about each one is exactly the noise a busy community cannot afford. Nothing of the message
   * crosses; the author's own devices hold it already (see `notifyReaction`).
   */
  async function notifyReactionAuthor(
    channelConversationId: string,
    messageId: string,
    emoji: string,
    removed: boolean,
    userId: string,
    ctx: ChannelWorkspaceContext
  ): Promise<void> {
    const author = ctx.conversations
      .get(channelConversationId)
      ?.messages.find((msg) => msg.id === messageId)?.senderId;
    if (removed || !author || author === userId) return;
    const getName = await resolveDisplayNames([userId]);
    void notifyReaction({
      groupId: channelConversationId,
      targetSenderId: author,
      emoji,
      messageId,
      actorName: getName(userId),
    }).catch(() => {});
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
    const trimmed = newName.trim();
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
   * Applies a drag or keyboard reorder of one community's salons optimistically, then persists it
   * for every member. Rolls back to the previous order if the request fails.
   */
  async function reorderChannels(
    workspaceSlug: string,
    newOrder: ChannelSidebarItem[],
    ctx: ChannelWorkspaceContext
  ) {
    const workspace = channelWorkspaces.find((ws) => ws.id === workspaceSlug);
    if (!workspace?.workspaceDbId) return;
    const previous = channelWorkspaces;
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.id === workspaceSlug ? { ...ws, channels: newOrder } : ws
    );
    try {
      await service.reorderChannels(
        workspace.workspaceDbId,
        newOrder.map((channel) => channel.id)
      );
    } catch (error) {
      channelWorkspaces = previous;
      ctx.log(toUiActionError(m.channel_action_channels_reorder(), error));
    }
  }

  /**
   * Re-reads one community's salon order from the server, after another member rearranged it.
   * The announcement carries no ids on purpose (a private salon must not leak to members who cannot
   * see it), so each device asks for its own filtered list and only reorders what it already has.
   */
  async function refreshChannelOrder(workspaceDbId: string): Promise<void> {
    const channels = (await service.listChannels(workspaceDbId)) as ChannelDto[];
    const orderedIds = channels
      .map((channel) => channel.id || channel._id)
      .filter((id): id is string => Boolean(id))
      .map((id) => `channel_${id}`);
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.workspaceDbId === workspaceDbId
        ? { ...ws, channels: orderByIds(ws.channels, orderedIds) }
        : ws
    );
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
   * THREE FLAGS ARE CACHED, and each is stated rather than re-derived: `viewerCanManage` (the
   * community), `viewerCanManageChannels` (its salons) and `viewerCanModerate` (other members'
   * messages - the pin and delete affordances) come from `listWorkspacesForUser`, which
   * reads the permission set of the roles a member holds. The event carries the same answers
   * computed by the same service, so applying them here cannot disagree with what the next load
   * will say.
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
    canManageChannels?: boolean;
    canModerate?: boolean;
    permissions: string[];
  }) {
    channelWorkspaces = channelWorkspaces.map((ws) =>
      ws.workspaceDbId === event.workspaceId
        ? {
            ...ws,
            viewerCanManage: event.canManage,
            ...(event.canManageChannels === undefined
              ? {}
              : { viewerCanManageChannels: event.canManageChannels }),
            ...(event.canModerate === undefined ? {} : { viewerCanModerate: event.canModerate }),
          }
        : ws
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
    const previous = channelWorkspaces.find(
      (ws) => ws.workspaceDbId === event.workspaceId
    )?.historyVisibility;
    const visibility =
      event.historyVisibility === undefined
        ? undefined
        : adoptHistoryVisibility(event.workspaceId, event.historyVisibility);
    if (visibility !== undefined && previous !== undefined && visibility !== previous) {
      // THE RULE MOVED UNDER AN OPEN SESSION. The history ask is where a closed past is recorded and
      // where a widened one is asked for again (`historyClosedSeen.ts`): a member already in, holding
      // seeds floored at their arrival, would otherwise never be handed the past the admin just
      // opened. A device that is offline now meets the same change at its next listing.
      console.info(
        `[CHANNEL] history rule of ${event.workspaceId.slice(0, 8)} moved ${previous} -> ${visibility}`
      );
      requestCommunityHistory(event.workspaceId).catch((e: unknown) =>
        console.warn(
          `[GRAINE] could not ask for the history of community ${event.workspaceId.slice(0, 8)} after its rule moved: ${String(e)}`
        )
      );
    }
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
    /** The account the list belongs to, or null - see the state's own note. */
    get workspacesOwner() {
      return workspacesOwner;
    },
    /** False while the list on screen is the saved snapshot, not yet confirmed by a listing. */
    get workspacesConfirmed() {
      return workspacesConfirmed;
    },
    /** Draws this account's saved community list before any session or network (boot only). */
    hydrateFromSnapshot,
    /** A sign-out: the list, its owner and every wait of the leaving account end. */
    forgetAccount,
    /** Conversation ID of the channel currently highlighted in the sidebar. */
    get selectedChannelConversationId() {
      return selectedChannelConversationId;
    },
    set selectedChannelConversationId(v) {
      selectedChannelConversationId = v;
    },
    /** Inserts or updates a workspace sidebar entry from a backend DTO. */
    upsertWorkspaceFromDto,
    /** Draws a salon created or heard of live, dated so a listing in flight cannot prune it. */
    addChannelToWorkspace,
    /** Removes a salon learned gone live, dated so a listing in flight cannot draw it back. */
    removeChannelFromWorkspaces,
    /** Returns or creates a sidebar workspace entry for an incoming real-time channel event. */
    ensureWorkspaceForChannelEvent,
    isCommunityUnknownToEvent,
    hydrateJoinedCommunity,
    /** Records the community of a channel the user was just added to in-session (no relaunch needed). */
    registerJoinedChannel,
    /** Enters a private salon an admin can see but has not joined, then re-reads the community. */
    joinPrivateChannelAsAdmin,
    /** Fetches all workspaces and channels from the backend and prunes stale local entries. */
    loadChannelWorkspacesFromBackend,
    retryFailedListing,
    /** Re-reads every salon's unread count from the server (one request). */
    refreshSalonUnread,
    /** "Marquer tout comme lu" on a community: every salon's badge, one request, no receipt. */
    markCommunityRead,
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
    /** Applies a reorder of one community's salons and persists it for every member. */
    reorderChannels,
    /** Re-reads a community's salon order after another member rearranged it. */
    refreshChannelOrder,
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
    /** Edits the caller's own text message (silent encrypted edit row, see `applyChannelEdit`). */
    editChannelMessage,
    /** Toggles the caller's emoji reaction on a channel message. */
    toggleChannelReaction,
    /** Applies an incoming real-time channel-message-deleted event. */
    handleChannelMessageDeleted,
  };
}
