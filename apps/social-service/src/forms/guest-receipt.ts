import { createHash, randomBytes } from 'node:crypto';

/**
 * A GUEST'S PROOF THAT AN ANSWER IS THEIRS, WITHOUT AN ACCOUNT (WP-P2 of the paid public forms
 * chantier, decision PP2) - the only thing the guest return page holds.
 *
 * A member's return page is authorised by the session (`assertSubmissionAccess`); a guest has none,
 * and the submission id cannot stand in for one: it travels in URLs and logs, and anything that
 * names a row is not a proof of owning it. So each paid guest answer gets its own RECEIPT: 32
 * random bytes, handed to the guest once (in the Lydia return URL `submit` builds) and stored only
 * as its SHA-256 (`submissions.guestReceiptHash`, migration 104). A read of the database therefore
 * yields no usable receipt, and a receipt names nothing a guess could reach: 256 bits, not an id.
 *
 * A plain SHA-256 and no salt is enough because the input is uniformly random and long: a salt or a
 * slow hash defends LOW-entropy secrets (passwords) against a dictionary, which this is not.
 */

/** A receipt as the guest holds it: 32 bytes in base64url, no padding - always 43 characters. */
const RECEIPT_RE = /^[A-Za-z0-9_-]{43}$/;

/** Mints a fresh receipt: the token for the guest, the hash for the row. */
export function newGuestReceipt(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashGuestReceipt(token) };
}

/** The stored form of a receipt (hex SHA-256, 64 characters). */
export function hashGuestReceipt(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether a string has a receipt's shape; anything else is answered as an unknown receipt. */
export function isGuestReceiptShape(token: unknown): token is string {
  return typeof token === 'string' && RECEIPT_RE.test(token);
}

/**
 * The ONE answer to a receipt that finds no answer - malformed, unknown, a submission id, a stored
 * hash - so a guess that reached a row and one that did not read alike (`confirmGuestReceipt`).
 */
export const GUEST_RECEIPT_NOT_FOUND = 'Receipt not found';

/**
 * What the guest return page reads, as an ALLOWLIST: the reference, the form (its id is in the
 * page's own URL already), the amount and where the payment stands. No submission id, no provider
 * id, no answer: the receipt proves the payment, and nothing more needs to travel with it.
 */
export interface GuestReceiptView {
  reference: string;
  formId: string;
  totalPaid: number;
  currency: string;
  paymentStatus: string;
  /** The provider state read on THIS call, as `confirmPayment` answers it; absent when none was. */
  requestState?: string;
}

/** Picks the guest's view out of what `FormsService.confirmPayment` answers. */
export function toGuestReceiptView(answer: {
  id: string;
  formId: string;
  totalPaid: number;
  currency: string;
  paymentStatus: string;
  requestState?: string;
}): GuestReceiptView {
  return {
    reference: guestReference(answer.id),
    formId: answer.formId,
    totalPaid: answer.totalPaid,
    currency: answer.currency,
    paymentStatus: answer.paymentStatus,
    ...(answer.requestState !== undefined ? { requestState: answer.requestState } : {}),
  };
}

/**
 * The reference a guest reads and gives the organiser ("1A2B-3C4D"): the first eight hex digits of
 * the submission id. It grants nothing - every route a guest reaches takes the receipt, never a
 * reference or an id - so it only has to be short to read aloud and enough to find one answer
 * among a form's responses, where the organiser's table shows the same eight digits.
 */
export function guestReference(submissionId: string): string {
  const hex = submissionId.replace(/-/g, '').slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}
