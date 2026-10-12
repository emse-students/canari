import { m } from '$lib/paraglide/messages';
import { SocialApiError } from './api';

/**
 * The typed refusals of an audience write or of a creation (social-service
 * `spaces/audience-policy.ts`, `AUDIENCE_ERROR`). Classified at the THROW by `request()` as
 * `SocialApiError.code`; a screen reads the code and never the English sentence.
 */
export const AUDIENCE_REFUSAL = {
  CREATOR_CAMPUS_REQUIRED: 'AUDIENCE_CREATOR_CAMPUS_REQUIRED',
  EVERYONE_INSTITUTION_ONLY: 'AUDIENCE_EVERYONE_INSTITUTION_ONLY',
  ADMIN_OR_BDE_REQUIRED: 'AUDIENCE_ADMIN_OR_BDE_REQUIRED',
  INSTITUTION_ADMIN_ONLY: 'AUDIENCE_INSTITUTION_ADMIN_ONLY',
  OUTSIDE_BDE_CAMPUS: 'AUDIENCE_OUTSIDE_BDE_CAMPUS',
} as const;

export type AudienceRefusalCode = (typeof AUDIENCE_REFUSAL)[keyof typeof AUDIENCE_REFUSAL];

const KNOWN: ReadonlySet<string> = new Set(Object.values(AUDIENCE_REFUSAL));

/** The audience refusal an error carries, or `null` for anything else (never a guess from prose). */
export function audienceRefusalCode(err: unknown): AudienceRefusalCode | null {
  if (err instanceof SocialApiError && err.code !== null && KNOWN.has(err.code)) {
    return err.code as AudienceRefusalCode;
  }
  return null;
}

/** The sentence for an audience refusal code, in the reader's language. */
export function audienceRefusalText(code: AudienceRefusalCode): string {
  switch (code) {
    case AUDIENCE_REFUSAL.CREATOR_CAMPUS_REQUIRED:
      return m.audience_err_creator_campus_required();
    case AUDIENCE_REFUSAL.EVERYONE_INSTITUTION_ONLY:
      return m.audience_err_everyone_institution_only();
    case AUDIENCE_REFUSAL.ADMIN_OR_BDE_REQUIRED:
      return m.audience_err_admin_or_bde_required();
    case AUDIENCE_REFUSAL.INSTITUTION_ADMIN_ONLY:
      return m.audience_err_institution_admin_only();
    case AUDIENCE_REFUSAL.OUTSIDE_BDE_CAMPUS:
      return m.audience_err_outside_bde_campus();
  }
}

/** The sentence for an error when it is an audience refusal, else `null` (the caller's own fallback). */
export function audienceRefusalMessage(err: unknown): string | null {
  const code = audienceRefusalCode(err);
  return code === null ? null : audienceRefusalText(code);
}
