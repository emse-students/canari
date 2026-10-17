import type { Submission } from './entities/submission.entity';

/**
 * WHAT A CLIENT MAY READ OF A SUBMISSION, AS AN ALLOWLIST (2026-10-15).
 *
 * Until then the routes answered the entity itself, or a hand-built object that carried
 * `paymentAccountId`: the Lydia Business's `vendor_token`, which with a sequential `request_id` is
 * all `request/cancel` asks for - so any submitter could cancel the open payment requests of other
 * people paying the same association. A denylist would have to name every column added later
 * (`stripeSessionId`, `paymentRequestId`, `paymentSettledBy` came in one migration); an allowlist
 * makes a new column private until someone decides otherwise. `submission.projection.spec.ts`
 * fails if a provider id or account key ever appears in one of these.
 */

/** The fields of a submission shown to the person who submitted it, and to the return pages. */
const SUBMITTER_FIELDS = [
  'id',
  'formId',
  'answers',
  'totalPaid',
  'paymentStatus',
  'paymentMethod',
  'cashExpiresAt',
  'createdAt',
] as const;

/**
 * The fields a form MANAGER reads in the responses lists. `userId` and `email` are there because
 * the list names the submitter (`submitterName`, the pending-cash list); a manager already reads
 * both on every member page. No provider id, no fulfilment flag.
 */
const MANAGER_FIELDS = [...SUBMITTER_FIELDS, 'userId', 'email'] as const;

export type SubmitterSubmissionView = Pick<Submission, (typeof SUBMITTER_FIELDS)[number]>;
export type ManagerSubmissionView = Pick<Submission, (typeof MANAGER_FIELDS)[number]>;

function pick<K extends keyof Submission>(
  submission: Submission,
  fields: readonly K[]
): Pick<Submission, K> {
  const view = {} as Pick<Submission, K>;
  for (const field of fields) view[field] = submission[field];
  return view;
}

/** A submission as its submitter (or a return page) may read it. */
export function toSubmitterView(submission: Submission): SubmitterSubmissionView {
  return pick(submission, SUBMITTER_FIELDS);
}

/** A submission as a form manager's responses list may read it. */
export function toManagerView(submission: Submission): ManagerSubmissionView {
  return pick(submission, MANAGER_FIELDS);
}
