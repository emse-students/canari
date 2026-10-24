/**
 * The community refusals the UI has to name precisely, keyed by the stable `code` social-service
 * throws alongside them.
 *
 * A code is a TYPE; the sentence beside it is prose the backend may reword at any moment, and a
 * distinction carried in prose is one exactly one call site will ever make. These live in one place
 * because the same refusal reaches the user from three different screens - leaving a community from
 * the sidebar, removing a member from the admin modal, and opening an invite link - and each of
 * them used to print the raw API body instead.
 */

import { m } from '$lib/paraglide/messages';

const COMMUNITY_REFUSALS: Record<string, () => string> = {
  /** Leaving, being kicked or being demoted would leave the community with members and no admin. */
  WORKSPACE_WOULD_HAVE_NO_ADMIN: () => m.chat_community_no_admin_left_error(),
  /**
   * A departure (leaving, a removal, an access change) that could not be completed this time: the
   * person is still a member and the same action may simply be retried.
   */
  DEPARTURE_SUPERSEDED: () => m.chat_community_departure_retry_error(),
  /** An invite link outliving its community: everyone who belonged to it is gone. */
  WORKSPACE_HAS_NO_MEMBERS: () => m.chat_community_gone_error(),
  /**
   * The invitee exists and has never opened Canari on any device, so no key could reach them.
   *
   * Deliberately a DIFFERENT sentence from the one below. Until 2026-08-19 the server could not
   * tell these apart at all: its device lookup answered "has devices" on a transport failure, so a
   * key service that was down let the invitation through and told the inviter it had worked.
   */
  USER_HAS_NO_DEVICE: () => m.chat_invite_user_has_no_device_error(),
  /** The key service could not be asked. About us, not about them, and worth retrying. */
  KEY_DISTRIBUTION_UNAVAILABLE: () => m.chat_key_distribution_unavailable_error(),
  /**
   * Someone the action would take access from (a kick, a salon removal, a salon made or created
   * private) holds a permission the actor does not: removals reach only so far.
   */
  REMOVAL_EXCEEDS_ACTOR: () => m.chat_community_removal_exceeds_actor_error(),
  /** A role assignment, permission edit or new role reaching past the actor's own permissions. */
  ROLE_CHANGE_EXCEEDS_ACTOR: () => m.chat_community_role_change_exceeds_actor_error(),
  /** An invitation naming a role its sender may not grant. */
  INVITE_ROLE_NOT_GRANTABLE: () => m.chat_invite_role_not_grantable_error(),
  /** A salon access edit computed from a row another edit changed since: nothing saved, retryable. */
  CHANNEL_ACCESS_CHANGED: () => m.chat_channel_access_changed_error(),
};

/**
 * The localized sentence for a coded refusal, or null when the code is unknown - in which case the
 * caller keeps whatever generic handling it already had, rather than inventing a wrong reason.
 */
export function describeCommunityRefusal(code: string | null | undefined): string | null {
  if (!code) return null;
  const describe = COMMUNITY_REFUSALS[code];
  return describe ? describe() : null;
}
