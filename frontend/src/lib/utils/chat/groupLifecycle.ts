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
    return { action: 'keep', reason: 'deja removed (suppression manuelle)' };
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
        return { action: 'keep', reason: 'vivant et toujours membre (snapshot perime)' };
      }
      // Plus membre d'un groupe vivant -> exclusion reelle (regle 4).
      return input.lifecycle === 'active'
        ? { action: 'markRemoved', reason: 'exclu (plus membre) du groupe vivant' }
        : { action: 'keep', reason: 'placeholder exclu (pending)' };
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
  /** True when this session has ALREADY registered the group as a community's seed carrier. */
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
 */
export function decideAbsentLocalGroupFate(input: AbsentLocalGroupInput): LocalGroupFate {
  if (input.isKnownDistributionGroup) {
    // NAMED BY THE SOURCE, not by the scope. This branch fires for a community's group AND a
    // private salon's - anything this device has registered a scope for - so calling it "community"
    // sent anyone chasing a salon's group looking at the wrong scope. What actually distinguishes
    // it from the branch below is WHO said so: this one is local knowledge, that one is the server.
    return { action: 'keep', reason: 'key-distribution group registered on this device' };
  }

  switch (input.serverStatus.kind) {
    case 'unknown':
      // Never destroy on doubt - the same rule the conversation reducer above obeys.
      return { action: 'keep', reason: 'server status uncertain (network)' };

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
      // A live-or-tombstoned conversation row we hold no membership in: the exclusion or the
      // deletion is real, and the local tree is what has to go. This is the behaviour the sweeps
      // always had, now taken on a row that was read rather than on a list that never named it.
      return { action: 'forget', reason: 'conversation row held with no membership left' };
  }
}

/**
 * Asks the server what a local group absent from the conversation list actually is, and decides.
 *
 * Shared by both reconcilers rather than written twice: the divergence between two copies of this
 * decision IS the defect this function exists to close, exactly as {@link decideAbsentGroupFate}
 * closed it for conversations.
 *
 * ONE REQUEST PER COMMUNITY PER SESSION, not per sweep. Learning that a group is a community's
 * seed carrier is worth remembering, so the answer is registered on the MLS service - the same
 * fact `ensureCommunityDistributionGroup` would have registered, whichever runs first. Every later
 * sweep in the session then answers from `isDistributionGroup` without a round trip, and the
 * ordering between the Graine layer and the reconcilers stops mattering at all.
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
  if (mlsService.isDistributionGroup(groupId)) {
    return decideAbsentLocalGroupFate({
      isKnownDistributionGroup: true,
      serverStatus: { kind: 'unknown' },
    });
  }

  const serverStatus = classifyServerStatus(await mlsService.getGroupServerStatus(groupId));
  const fate = decideAbsentLocalGroupFate({ isKnownDistributionGroup: false, serverStatus });

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
