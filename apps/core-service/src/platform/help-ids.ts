/**
 * THE FIRST-TIME HELPS AN ACCOUNT CAN HAVE SEEN - the server's allowlist for `help_seen`.
 *
 * An id outside this list is refused at the route, so the table can never hold more than one row
 * per account per entry here, whatever a client sends. The list is shared with the frontend as data
 * (`libs/contracts/help-ids.json`) and `help-ids.spec.ts` asserts this copy equals it: a help
 * declared on the client and missing here would be recorded locally and refused on every device.
 */
export const HELP_IDS = [
  'welcome-tour',
  'hint-create-post',
  'hint-create-event',
  'hint-create-form',
  'hint-feed-tabs',
  'hint-reels',
  'hint-chats',
  'hint-asso-shop',
  'hint-asso-post-as',
  'hint-asso-manage',
  'hint-asso-manage-hub',
  'hint-booking-spaces',
  'hint-booking-week',
  'prompt-profile-photo',
  'prompt-profile-photo-reminder',
] as const;

/**
 * The `code` of the 400 refusing an id outside {@link HELP_IDS} - the one answer a client treats
 * as permanent (it drops the write); shared as `unknownIdCode` in the same contract.
 */
export const HELP_ID_UNKNOWN = 'HELP_ID_UNKNOWN';

export type HelpId = (typeof HELP_IDS)[number];

/** Narrows an untrusted string (a path segment) to a known help id. */
export function isHelpId(value: unknown): value is HelpId {
  return typeof value === 'string' && (HELP_IDS as readonly string[]).includes(value);
}
