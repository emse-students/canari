/**
 * THE FIRST-TIME HELPS AN ACCOUNT CAN HAVE SEEN - the server's allowlist for `help_seen`.
 *
 * An id outside this list is refused at the route, so the table can never hold more than one row
 * per account per entry here, whatever a client sends. The list is shared with the frontend as data
 * (`libs/contracts/help-ids.json`) and `help-ids.spec.ts` asserts this copy equals it: a help
 * declared on the client and missing here would be recorded locally and refused on every device.
 */
export const HELP_IDS = ['welcome-tour'] as const;

export type HelpId = (typeof HELP_IDS)[number];

/** Narrows an untrusted string (a path segment) to a known help id. */
export function isHelpId(value: unknown): value is HelpId {
  return typeof value === 'string' && (HELP_IDS as readonly string[]).includes(value);
}
