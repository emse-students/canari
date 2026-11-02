/**
 * THE FIRST-TIME HELPS THIS CLIENT CAN DECLARE - each a guided tour or a hint, recorded once per
 * account on the server (`help_seen`, core-service).
 *
 * The server refuses any id outside its own copy of this list, and both copies are asserted equal to
 * `libs/contracts/help-ids.json` (`helpIds.contract.test.ts` here, `help-ids.spec.ts` there). A new
 * help appends its id to the JSON and to both lists in the same pull request - the guide's own
 * declaration then names it, and TypeScript refuses a declaration under any other id.
 */
export const HELP_IDS = ['welcome-tour'] as const;

export type HelpId = (typeof HELP_IDS)[number];

/** Narrows an untrusted string (a server answer, a stored copy) to a known help id. */
export function isHelpId(value: unknown): value is HelpId {
  return typeof value === 'string' && (HELP_IDS as readonly string[]).includes(value);
}
