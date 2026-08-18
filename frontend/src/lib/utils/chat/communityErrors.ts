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
  /** An invite link outliving its community: everyone who belonged to it is gone. */
  WORKSPACE_HAS_NO_MEMBERS: () => m.chat_community_gone_error(),
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
