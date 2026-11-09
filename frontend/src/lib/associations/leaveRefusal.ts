import { m } from '$lib/paraglide/messages';
import { LEAVE_REFUSAL, SocialApiError } from '$lib/associations/api';

/**
 * The sentence for a refused "Quitter" (owner, 2026-11-03), read from the typed code the server
 * classified at the throw, never from its message. `null` when the refusal is not one the button
 * knows - the caller then shows its generic error.
 */
export function leaveRefusalMessage(err: unknown): string | null {
  if (!(err instanceof SocialApiError)) return null;
  switch (err.code) {
    case LEAVE_REFUSAL.LAST_MEMBER_MANAGER:
      return m.asso_leave_last_manager();
    default:
      return null;
  }
}
