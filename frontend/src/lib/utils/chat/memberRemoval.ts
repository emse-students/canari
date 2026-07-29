/**
 * What a `channel.member.kicked` / `channel.member.removed` broadcast means for the client that
 * receives it.
 *
 * The server sends both events to every remaining member as well as to the person being removed,
 * so receiving one says nothing on its own - the payload has to be read before any local state is
 * touched.
 */
export type RemovalOutcome =
  /** Somebody else was removed: nothing local changes. */
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
