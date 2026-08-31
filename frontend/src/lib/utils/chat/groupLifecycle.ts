import type { GroupMeta, IMlsService } from '$lib/mls-client/IMlsService';
import { workspaceScope, type DistributionScope } from '$lib/mls-client/distributionScope';
import { scopeForChannel } from '$lib/utils/graine/runtime';
import type { ConversationLifecycle } from '$lib/types';

export type { ConversationLifecycle };

/**
 * Normalizes a lifecycle value loaded from storage. Tolerates legacy rows (predating this field)
 * that only carried an `isReady` boolean: `true -> active`, otherwise `pending` (the old model
 * never persisted the `removed` state). Any unknown value falls back to `pending` (the safest:
 * it triggers a recovery, never a purge nor a send).
 */
export function normalizeConversationLifecycle(
  raw: unknown,
  legacyIsReady?: boolean
): ConversationLifecycle {
  if (raw === 'active' || raw === 'pending' || raw === 'removed') return raw;
  return legacyIsReady ? 'active' : 'pending';
}

/**
 * Group lifecycle: SINGLE SOURCE OF TRUTH and centralized decision logic.
 *
 * Context (see audit): the question "is this local group still real, and what should I do with
 * it?" used to be re-implemented in 3-4 reconcilers (discovery, sync-on-connect, requestReAdd)
 * with diverging guards -> every divergence was a bug (undeletable ghost, "uncertain status" on
 * an already-deleted group, etc.). This module factors out:
 *   1. `classifyServerStatus`: turns the server's ambiguous response into an explicit state.
 *   2. `decideAbsentGroupFate`: PURE reducer mapping (server state + local signals) -> action.
 * All reconcilers consume these two functions, so there is a single logic to maintain.
 *
 * Reminder of a group's 3 server states (table `dm_groups`):
 *  - `active`    : row present, `deletedAt` null -> the group is alive.
 *  - `tombstone` : row present, `deletedAt` non-null -> deleted by a peer (kept 90d, cron).
 *  - `absent`    : no row at all -> never created, hard-purged after 90d, or database wiped.
 * Plus a 4th client-side state: `unknown` (network failure) -> NEVER purge on a doubt.
 */

/** Explicit server state of a group (resolves the `null` ambiguity of `getGroupMeta`/`getGroupServerStatus`). */
export type GroupServerStatus =
  | { kind: 'active'; meta: GroupMeta }
  | { kind: 'tombstone'; meta: GroupMeta }
  | { kind: 'absent' }
  | { kind: 'unknown' };

/**
 * Converts the raw value of `IMlsService.getGroupServerStatus` (`'absent' | 'error' | GroupMeta`)
 * into a {@link GroupServerStatus}. A `GroupMeta` with a non-null `deletedAt` is a tombstone.
 */
export function classifyServerStatus(raw: 'absent' | 'error' | GroupMeta): GroupServerStatus {
  if (raw === 'absent') return { kind: 'absent' };
  if (raw === 'error') return { kind: 'unknown' };
  return raw.deletedAt ? { kind: 'tombstone', meta: raw } : { kind: 'active', meta: raw };
}

/**
 * Action to apply to a local conversation after reconciliation.
 *  - `keep`        : do nothing (group still valid, or doubt -> keep it).
 *  - `purge`       : remove the conversation (and the MLS state) -> the group no longer exists AT ALL.
 *  - `markRemoved` : move the conversation to `removed` ("deleted/excluded" banner, manual deletion).
 */
export type ConversationFate = {
  action: 'keep' | 'purge' | 'markRemoved';
  /** Human-readable reason (for diagnostic logs). */
  reason: string;
};

/** Input signals for {@link decideAbsentGroupFate}. */
export interface AbsentGroupFateInput {
  /** Current lifecycle state of the local conversation. */
  lifecycle: ConversationLifecycle;
  /** Resolved server state (see `classifyServerStatus`). */
  serverStatus: GroupServerStatus;
  /**
   * Anti-race re-validation of OUR user-level membership (`dm_group_members`), used only when
   * the group is `active` but missing from our `getUserGroups` snapshot:
   *  - `true`  : we are still a member -> stale snapshot, keep the conversation active.
   *  - `false` : we are no longer a member -> real exclusion -> banner.
   *  - `null`  : impossible to determine (network) -> keep it, benefit of the doubt.
   * Not relevant (and ignored) for the other server states.
   */
  isStillUserMember: boolean | null;
}

/**
 * PURE reducer: decides the fate of a local conversation ABSENT from our active membership
 * (`getUserGroups`). This is the former `if (!serverGroupIds.has(…))` block from
 * `discoverMissingGroups`, extracted as-is for exhaustive testing and sharing.
 *
 * Guiding principle: the SERVER is the source of truth for existence, EXCEPT for purely local
 * survivors (deleted-by-peer / exclusion -> banner; manual dismiss -> purge elsewhere)
 * that remain until manual deletion. We NEVER purge on network doubt.
 */
export function decideAbsentGroupFate(input: AbsentGroupFateInput): ConversationFate {
  // Already `removed`: stays until local MANUAL DELETION (rules 2 & 4), regardless of
  // server-side state (even after hard-purge of the tombstone). Never re-queried or re-purged.
  if (input.lifecycle === 'removed') {
    return { action: 'keep', reason: 'already removed, awaiting a manual deletion' };
  }

  switch (input.serverStatus.kind) {
    case 'absent':
      // No dm_groups row left: the group no longer exists at all (rule 1) -> purge.
      return { action: 'purge', reason: 'absent from dm_groups (confirmed)' };

    case 'unknown':
      // Network failure: indistinguishable from a deleted group -> never purge on doubt.
      return { action: 'keep', reason: 'server status uncertain (network)' };

    case 'tombstone':
      // Deleted by a peer (rule 2). A plain placeholder (pending) is kept as-is.
      return input.lifecycle === 'active'
        ? { action: 'markRemoved', reason: 'deleted (tombstone) server-side' }
        : { action: 'keep', reason: 'placeholder tombstone (pending)' };

    case 'active':
      // Alive server-side but absent from our getUserGroups snapshot, which may be stale for
      // a group we just created/joined. Revalidate real membership before marking.
      if (input.isStillUserMember === null) {
        return { action: 'keep', reason: 'members unavailable (doubt)' };
      }
      if (input.isStillUserMember) {
        return { action: 'keep', reason: 'alive and still a member (stale snapshot)' };
      }
      // No longer a member of a live group -> a real exclusion (rule 4).
      return input.lifecycle === 'active'
        ? { action: 'markRemoved', reason: 'excluded (no longer a member) from a live group' }
        : { action: 'keep', reason: 'placeholder for an exclusion (pending)' };
  }
}

/** What a reconciler may do to LOCAL MLS STATE for a group absent from `getUserGroups`. */
export type LocalGroupFate = {
  action: 'forget' | 'keep';
  /** Human-readable cause, for the log line the caller writes. */
  reason: string;
};

/** Signals {@link decideAbsentLocalGroupFate} reduces. Both are facts, never guesses. */
export interface AbsentLocalGroupInput {
  /**
   * True when this session has ALREADY registered the group as a community's seed carrier.
   *
   * ONLY CONSULTED WHEN THE SERVER CANNOT BE BELIEVED. It answers what the group IS, which is not
   * evidence that it still exists - see the note on {@link reconcileAbsentLocalGroup}.
   */
  isKnownDistributionGroup: boolean;
  /** Resolved server state of the `dm_groups` row (see {@link classifyServerStatus}). */
  serverStatus: GroupServerStatus;
}

/**
 * PURE reducer: may this device destroy the local MLS state of a group the conversation list did
 * not name?
 *
 * WHY THIS IS NOT "ABSENT FROM THE LIST" ANY MORE. `GET /api/mls/users/:id/groups` is the one
 * place a client learns which CONVERSATIONS exist, and it excludes a community's Graine
 * key-distribution group on purpose - that group carries seeds, never a message, and holds no
 * `dm_group_members` row by construction. Two reconcilers read that list as "every group this
 * device may hold" and forgot the distribution group on every single connection (WP-GRAINE-1,
 * found on prod 2026-08-19): the checkpoint made the loss durable, the next boot re-joined by
 * external commit, and whichever of the two won the race decided whether the user could send at
 * all. Sending was impossible whenever the sweep landed last.
 *
 * So absence from that list stopped being a reason to destroy anything. It is only a reason to
 * ASK, and the answer names the kind of group: a distribution group is kept, a row that is simply
 * gone is forgotten, a network failure decides nothing.
 *
 * AND THE SERVER'S ANSWER OUTRANKS WHAT THIS SESSION REMEMBERS. `isKnownDistributionGroup` used to
 * be an unconditional first branch, which made a memory of what the group WAS stand in for whether
 * it still exists - two different questions with two different lifetimes. It is now consulted in
 * the one case where nothing better exists: `unknown`.
 *
 * WHAT THIS REDUCER KNOWS IS EXACTLY ITS INPUT, AND EVERY `reason` SAYS SO. Absence from
 * `getUserGroups` is the CALLER's precondition - it is why this function was called at all, and it
 * is not re-derivable from anything passed in - so a reason may cite it as a caller's fact and may
 * cite nothing else it has not read. It notably knows NOTHING about `dm_group_members`, and one
 * `reason` claimed otherwise for as long as it existed.
 */
export function decideAbsentLocalGroupFate(input: AbsentLocalGroupInput): LocalGroupFate {
  switch (input.serverStatus.kind) {
    case 'unknown':
      // Never destroy on doubt - the same rule the conversation reducer above obeys. This is the
      // whole remaining use of the local flag: when the row cannot be read, what this session
      // registered is the only thing left to go on, and it says spare it.
      return {
        action: 'keep',
        reason: input.isKnownDistributionGroup
          ? 'key-distribution group registered on this device, server status uncertain'
          : 'server status uncertain (network)',
      };

    case 'absent':
      // No `dm_groups` row at all: nothing this state could ever belong to again.
      return { action: 'forget', reason: 'absent from dm_groups (confirmed)' };

    case 'active':
    case 'tombstone':
      if (
        input.serverStatus.meta.distributionWorkspaceId ||
        input.serverStatus.meta.distributionChannelId
      ) {
        // Either scope. A private salon's group is no more a conversation than a community's, and
        // a sweep reading only the community field would destroy every one of them.
        return { action: 'keep', reason: 'key-distribution group, not a conversation' };
      }
      // A ROW THAT NAMES NO SCOPE IS NOT A SEED CARRIER ANY MORE, whatever this session remembers.
      // Deleting a community clears the distribution columns of its group and tombstones the row,
      // so this is where the carrier of a community that is gone is finally collected - the state
      // that otherwise survives every sweep for ever because the local predicate outlives it.
      //
      // THE REASON NAMES THE TWO FACTS THIS BRANCH HAS AND NOTHING ELSE. It read
      // `'conversation row held with no membership left'` until 2026-08-31, and no membership is
      // ever read here - the input carries a `dm_groups` row and a local predicate. The claim was
      // wrong in a destructive branch's own log line, which is where a wrong claim costs the most:
      // it is the sentence a reader reaches for when a group has been forgotten and nobody knows
      // why, and it sent them to `dm_group_members`, which had nothing to say.
      return input.serverStatus.kind === 'tombstone'
        ? { action: 'forget', reason: 'dm_groups row tombstoned and naming no distribution scope' }
        : {
            action: 'forget',
            reason: 'dm_groups row alive, naming no distribution scope, absent from our group list',
          };
  }
}

/**
 * Asks the server what a local group absent from the conversation list actually is, and decides.
 *
 * Shared by both reconcilers rather than written twice: the divergence between two copies of this
 * decision IS the defect this function exists to close, exactly as {@link decideAbsentGroupFate}
 * closed it for conversations.
 *
 * THE ROW IS READ EVERY TIME, INCLUDING FOR A GROUP THIS SESSION HAS ALREADY IDENTIFIED, and that
 * read used to be short-circuited. `isDistributionGroup` answers "does this carry seeds rather than
 * messages" - the question WP-GRAINE-1 needed - and it was being read as "does this group still
 * exist", which it has never been evidence for. The two differ only in lifetime: the predicate is
 * true for the rest of the session, the group can stop existing at any point inside it.
 *
 * NOTHING ELSE WOULD EVER COLLECT WHAT THE SHORT-CIRCUIT SPARED. The purge that owns forgetting a
 * community's carriers (`forgetCommunityGraine`, WP-60) enumerates `distributionScopes()`, and a
 * group the server identified as a salon's carrier while this session could not yet name its
 * community is recorded by `noteDistributionGroup` - in the predicate, in no scope. It is therefore
 * unreachable from the purge side by construction, and only a caller holding the server's answer
 * can end it. Measured on production 2026-08-21: `b0192801`, tombstoned with its distribution
 * columns cleared, still held by a web client and still starting a recovery attempt on every load,
 * three hours after the community it belonged to was deleted through the product.
 *
 * THE ANSWER IS AUTHORITATIVE AND THE EXTRA REQUEST BUYS IT. `GET /api/mls/groups/:id` reads
 * `dm_groups` with NO membership check, so the exclusion that hid distribution groups from
 * `getUserGroups` does not apply; and a distribution group cannot be held locally before the server
 * named it, since `ensureDistributionGroupFor` takes the id from `getDistributionGroup` and joins
 * only afterwards. There is no window in which a live group reads absent. The registration below
 * still happens, so the Graine layer keeps learning the scope from whichever sweep saw the row
 * first - it just no longer decides on that memory alone.
 */
export async function reconcileAbsentLocalGroup(
  mlsService: Pick<
    IMlsService,
    | 'isDistributionGroup'
    | 'getGroupServerStatus'
    | 'registerDistributionGroup'
    | 'noteDistributionGroup'
  >,
  groupId: string
): Promise<LocalGroupFate> {
  const isKnownDistributionGroup = mlsService.isDistributionGroup(groupId);
  const serverStatus = classifyServerStatus(await mlsService.getGroupServerStatus(groupId));
  const fate = decideAbsentLocalGroupFate({ isKnownDistributionGroup, serverStatus });

  if (serverStatus.kind === 'active' || serverStatus.kind === 'tombstone') {
    const meta = serverStatus.meta;
    const scope = distributionScopeFromMeta(meta);
    if (scope) {
      mlsService.registerDistributionGroup(scope, groupId);
    } else if (meta.distributionWorkspaceId || meta.distributionChannelId) {
      // KEPT AND SAID SO. The decision above already spared this group on the server's word; before
      // this line that word was then thrown away, and `isDistributionGroup` answered false about a
      // group the server had just identified. Every later consumer of the predicate inherited the
      // ignorance - including the history reconciliation, which probed it as a conversation.
      mlsService.noteDistributionGroup(groupId);
    }
  }
  return fate;
}

/**
 * The scope a group's server metadata names, or null when it names none.
 *
 * A COMMUNITY IS SELF-CONTAINED, A SALON IS NOT. The `dm_groups` row of a salon's group carries the
 * salon's id and cannot carry the community's - chat-delivery does not own `channels` and has no
 * way to know it - so the community comes from the channel map this session already built while
 * loading the sidebar. When it has not (a salon this session never loaded), the group is still
 * KEPT by the decision above; it is only the registration that waits, and the next community load
 * makes it.
 */
function distributionScopeFromMeta(meta: GroupMeta): DistributionScope | null {
  if (meta.distributionWorkspaceId) return workspaceScope(meta.distributionWorkspaceId);
  if (!meta.distributionChannelId) return null;

  const known = scopeForChannel(meta.distributionChannelId);
  if (known?.kind === 'channel') return known;
  console.info(
    `[GRAINE] group of salon ${meta.distributionChannelId.slice(0, 8)} kept but not registered - ` +
      `its community is not loaded in this session yet`
  );
  return null;
}
