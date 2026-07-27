import type { GroupMeta } from '$lib/mls-client/IMlsService';
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
