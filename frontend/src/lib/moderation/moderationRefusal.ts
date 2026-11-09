import { m } from '$lib/paraglide/messages';
import { refusalCode } from '$lib/utils/apiRefusal';
import { Log } from '$lib/utils/Log';

/**
 * The typed codes social-service puts on a refused MODERATION act (hide, unhide, unmask, delete a
 * post or a comment, cut a live, review a report) - the copy of the constants of
 * `apps/social-service/src/spaces/bde-moderation.ts`, pinned to them by `moderationRefusal.test.ts`.
 *
 * `MODERATION_RESERVED_TO_PLATFORM_ADMIN` is the owner's rule of 2026-11-03: no BDE moderates what
 * is published in an institution's or another BDE's name - only the platform admin does.
 */
export const MODERATION_REFUSAL_CODES = {
  MODERATION_RESERVED_TO_PLATFORM_ADMIN: 'MODERATION_RESERVED_TO_PLATFORM_ADMIN',
  MODERATION_OUT_OF_SCOPE: 'MODERATION_OUT_OF_SCOPE',
  MODERATOR_REQUIRED: 'MODERATOR_REQUIRED',
} as const;

const WORDING: Readonly<Record<string, () => string>> = {
  [MODERATION_REFUSAL_CODES.MODERATION_RESERVED_TO_PLATFORM_ADMIN]:
    m.moderation_refusal_reserved_to_platform_admin,
  [MODERATION_REFUSAL_CODES.MODERATION_OUT_OF_SCOPE]: m.moderation_refusal_out_of_scope,
  [MODERATION_REFUSAL_CODES.MODERATOR_REQUIRED]: m.moderation_refusal_moderator_required,
};

/**
 * The sentence for a refused moderation act, read from the refusal's CODE (never its English
 * message), or `null` when the error carries none of these codes - the caller then keeps its own
 * generic line rather than inventing a reason.
 *
 * @param error What the moderation call threw.
 */
export function describeModerationRefusal(error: unknown): string | null {
  const code = refusalCode(error);
  if (!code || !Object.hasOwn(WORDING, code)) return null;
  Log.d(`moderation refusal code=${code}`);
  return WORDING[code]();
}
