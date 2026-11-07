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
 */

/** 30 days, in seconds - the owner's interval between the invitation and its one reminder. */
export const PROFILE_PHOTO_REMINDER_AFTER_SECONDS = 30 * 24 * 60 * 60;

export type ProfilePhotoPromptFacts = {
  /** `true`/`false` from the gallery's presence answer; `null` when nobody could say (never prompt). */
  readonly hasPhoto: boolean | null;
  readonly firstSeen: boolean;
  readonly reminderSeen: boolean;
  readonly firstAgeSeconds: number | null;
};

/** Which of the two prompts is due now, or `null`. */
export function profilePhotoPromptStage(
  facts: ProfilePhotoPromptFacts
): 'first' | 'reminder' | null {
  if (facts.hasPhoto !== false) return null;
  if (!facts.firstSeen) return 'first';
  if (facts.reminderSeen) return null;
  if (facts.firstAgeSeconds === null) return null;
  return facts.firstAgeSeconds >= PROFILE_PHOTO_REMINDER_AFTER_SECONDS ? 'reminder' : null;
}
