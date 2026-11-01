/**
 * What a `channel.member.kicked` / `channel.member.removed` broadcast means for the client that
 * receives it.
 *
 * The server sends both events to every remaining member as well as to the person being removed,
 * so receiving one says nothing on its own - the payload has to be read before any local state is
 * touched.
 */
export type RemovalOutcome =
  /**
   * Somebody else was removed: nothing local changes. The key-group Remove it owes is committed by
   * the device that performed the kick or the revoke (`utils/graine/commitRemoval.ts`) - or, for a
   * leave or an actor holding no leaf, by ONE remaining device every receiver elects alike
   * (`utils/graine/departureCommitter.ts`) - never by every receiver of this fan-out.
   */
  | 'ignore'
  /** This user was removed from the whole community: purge the workspace. */
  | 'community'
  /** This user lost access to one private channel: purge that channel. */
  | 'channel'
  /** This user was taken off a PUBLIC channel, which they can still read: nothing to do. */
  | 'public-channel';

/**
 * Decides what a removal broadcast costs the receiving client.
 *
 * Two traps this encodes:
 * - the event is fan-out, so acting without comparing `kickedUserId` to the local user wipes
 *   state on behalf of somebody else's removal;
 * - a public channel stays readable by every workspace member, so removing someone from one only
 *   rotates the epoch key. Dropping it from the sidebar would be undone by the next reload.
 *
 * @param input.localUserId Current user id, or null when the session is not ready.
 * @param input.kickedUserId User the server says was removed.
 * @param input.channelId Channel the removal applies to; empty for a community-wide removal.
 * @param input.channelIsPrivate Whether that channel is private (irrelevant community-wide).
 */
/**
 * THE ORDER OF A SALON'S GRANTS AND REMOVALS, BY THE SERVER'S OWN REVISION (`accessRevision`).
 *
 * A leave followed by a quick re-invitation produces two broadcasts. Should the removal be handled
 * after the grant - delivered late, or by another socket - the client would purge a salon its user
 * is back in, until the next reload. Both broadcasts carry the salon's access revision as the write
 * left it, so the later one is KNOWN, not guessed: a removal older than a grant already seen for the
 * same person and salon is superseded and changes nothing. A broadcast without a revision (an older
 * server) is never superseded - the behaviour before this existed.
 */
export class SalonGrantLedger {
  private readonly highest = new Map<string, number>();

  private static key(channelId: string, userId: string): string {
    return `${channelId.replace(/^channel_/, '')}|${userId.trim().toLowerCase()}`;
  }

  /** Records that `userIds` were granted `channelId` at `revision`. */
  noteGrant(channelId: string, userIds: string[], revision: unknown): void {
    if (typeof revision !== 'number') return;
    for (const userId of userIds) {
      const key = SalonGrantLedger.key(channelId, userId);
      if ((this.highest.get(key) ?? -1) < revision) this.highest.set(key, revision);
    }
  }

  /** Whether a removal of `userId` from `channelId` at `revision` predates a grant already seen. */
  supersedes(channelId: string, userId: string, revision: unknown): boolean {
    if (typeof revision !== 'number') return false;
    const granted = this.highest.get(SalonGrantLedger.key(channelId, userId));
    return granted !== undefined && granted > revision;
  }

  /** Forgets everything - a sign-out. */
  clear(): void {
    this.highest.clear();
  }
}

/** The session's ledger, fed and read by the channel event pipeline (`channelEventHandler.ts`). */
export const salonGrants = new SalonGrantLedger();

/** The removal broadcast as the event pipeline hands it over (`deps.ts`, `onChannelMemberKicked`). */
export interface RemovalEvent {
  channelId: string;
  workspaceId?: string;
  kickedUserId: string;
  kickedBy?: string;
  actorDeviceId?: string;
  channelIsPrivate?: boolean;
}

/**
 * Whether the local user LEFT the salon themselves - a leave is announced to their own devices too
 * (2026-10-27), so they drop it; telling them they were "removed" would be false.
 */
export function isOwnLeave(event: RemovalEvent, localUserId?: string | null): boolean {
  const me = localUserId?.trim().toLowerCase();
  return (
    !!me &&
    String(event.kickedBy ?? '')
      .trim()
      .toLowerCase() === me
  );
}

/**
 * What an `ignore` removal (somebody else's) hands to `commitDepartureIfElected`, or null when it
 * names no community or nobody - nothing could be elected for it.
 */
export function departureToDecide(event: RemovalEvent): {
  workspaceId: string;
  channelId: string;
  channelIsPrivate: boolean;
  departedUserId: string;
  actorUserId?: string;
  actorDeviceId?: string;
} | null {
  if (!event.workspaceId || !event.kickedUserId) return null;
  return {
    workspaceId: String(event.workspaceId),
    channelId: event.channelId,
    channelIsPrivate: event.channelIsPrivate === true,
    departedUserId: event.kickedUserId,
    actorUserId: event.kickedBy,
    actorDeviceId: event.actorDeviceId,
  };
}

export function removalOutcome(input: {
  localUserId?: string | null;
  kickedUserId?: string | null;
  channelId?: string | null;
  channelIsPrivate?: boolean;
}): RemovalOutcome {
  const me = input.localUserId?.trim().toLowerCase();
  const target = input.kickedUserId?.trim().toLowerCase();
  if (!me || !target || me !== target) return 'ignore';
  if (!input.channelId) return 'community';
  return input.channelIsPrivate ? 'channel' : 'public-channel';
}
