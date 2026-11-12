/**
 * THE DECISION BEHIND THE PROFILE-PHOTO PROMPT (owner, 2026-11-07): an account with NO profile photo
 * is invited to add one - once; if it still has none 30 days after that first showing, ONE reminder;
 * then never again.
 *
 * Pure, so the whole rule is pinned without a DOM or a clock. The 30 days are read as
 * `firstAgeSeconds`, the age of the FIRST showing's `help_seen` row measured by the SERVER
 * (`HelpSeenService.seenWithAges`): this function never reads a clock, and a skewed device clock
 * cannot move the reminder. An age the server has not told yet (the first showing was recorded on
 * this device and is still owed) is `null`: not due, never guessed.
 *
 * NOTHING IN SEPTEMBER (owner, 2026-11-10): the new students arrive then and MiGallery holds no
 * photo of them before October, so an invitation would send them to an empty gallery. The month is
 * a calendar gate, not a clock deciding idempotence: a skewed device moves it by its skew only, and
 * the prompt simply waits for October.
 */

/** The month (1-12) in which neither prompt is shown: the gallery has no new-student photo yet. */
export const PROFILE_PHOTO_PROMPT_QUIET_MONTH = 9;

/** 30 days, in seconds - the owner's interval between the invitation and its one reminder. */
export const PROFILE_PHOTO_REMINDER_AFTER_SECONDS = 30 * 24 * 60 * 60;

export type ProfilePhotoPromptFacts = {
  /**
   * Whether the server offers this account the prompt - TEMPORARY (owner, 2026-11-10): only the
   * spaces its `PROFILE_PHOTO_PROMPT_SPACES` names. `false` until the server has answered.
   */
  readonly eligible: boolean;
  /** `true`/`false` from the gallery's presence answer; `null` when nobody could say (never prompt). */
  readonly hasPhoto: boolean | null;
  readonly firstSeen: boolean;
  readonly reminderSeen: boolean;
  readonly firstAgeSeconds: number | null;
  /** The current calendar month, 1-12. */
  readonly month: number;
};

/** Which of the two prompts is due now, or `null`. */
export function profilePhotoPromptStage(
  facts: ProfilePhotoPromptFacts
): 'first' | 'reminder' | null {
  if (!facts.eligible) return null;
  if (facts.hasPhoto !== false) return null;
  if (facts.month === PROFILE_PHOTO_PROMPT_QUIET_MONTH) return null;
  if (!facts.firstSeen) return 'first';
  if (facts.reminderSeen) return null;
  if (facts.firstAgeSeconds === null) return null;
  return facts.firstAgeSeconds >= PROFILE_PHOTO_REMINDER_AFTER_SECONDS ? 'reminder' : null;
}
