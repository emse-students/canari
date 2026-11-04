/**
 * THE FIRST-TIME HELPS THIS CLIENT CAN DECLARE - each a guided tour or a hint, recorded once per
 * account on the server (`help_seen`, core-service).
 *
 * The server refuses any id outside its own copy of this list, and both copies are asserted equal to
 * `libs/contracts/help-ids.json` (`helpIds.contract.test.ts` here, `help-ids.spec.ts` there). A new
 * help appends its id to the JSON and to both lists in the same pull request - the guide's own
 * declaration then names it, and TypeScript refuses a declaration under any other id.
 */
export const HELP_IDS = [
  'welcome-tour',
  'hint-create-post',
  'hint-create-event',
  'hint-create-form',
  'hint-feed-tabs',
  'hint-reels',
  'hint-chats',
  'whats-new-1-6-3',
] as const;

/**
 * The `code` of the server's 400 for an id outside its list - the ONE refusal that is permanent:
 * the write is dropped. Every other failure (a 429, a 408, a 5xx, no answer) stays owed. Shared as
 * `unknownIdCode` in the same contract.
 */
export const HELP_ID_UNKNOWN = 'HELP_ID_UNKNOWN';

export type HelpId = (typeof HELP_IDS)[number];

/** Narrows an untrusted string (a server answer, a stored copy) to a known help id. */
export function isHelpId(value: unknown): value is HelpId {
  return typeof value === 'string' && (HELP_IDS as readonly string[]).includes(value);
}
