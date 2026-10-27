import { randomBytes } from 'crypto';

/**
 * The longest `order_ref` a form request may send. A uuid submission id gives exactly this; the
 * cap is pinned by a test so a later change cannot lengthen it unnoticed.
 *
 * WHY THIS NUMBER: Lydia's apiDoc (`POST /api/request/do`, field `order_ref`) documents NO maximum
 * length, only "must be unique". What has been measured accepted is 109 characters (sandbox,
 * 2026-10-21) and the legacy 41-character `form:<uuid>`; no production log retains the length of
 * an accepted order_ref. So the per-request discriminator is kept as short as uniqueness allows
 * (8 hex digits), and the whole stays well inside the measured 109.
 */
export const FORM_ORDER_REF_MAX_LENGTH = 50;

/** Hex digits of the per-request attempt part: 32 random bits, against a handful of attempts. */
const ATTEMPT_HEX_DIGITS = 8;

/**
 * The Lydia `order_ref` of ONE payment request issued for a form answer:
 * `form:<submissionId>:<8 hex digits>`, 50 characters for a uuid submission id.
 *
 * WHY PER ATTEMPT: Lydia refuses a second `request/do` carrying an order_ref it has already seen
 * (error 3, "order_ref deja utilise", measured on dev 2026-10-21), and a retry REUSES the live
 * pending row (`FormsService.submit`), so the old `form:<submissionId>` made every retry of a
 * declined or cancelled payment fail at Lydia. The boutique had the same defect and the same cure
 * (`productOrderRef`, migration 101). The submission id keeps the string unique across answers;
 * the attempt part only has to differ between the few requests of ONE answer, which 32 random
 * bits do.
 *
 * The attempt part is NOT stored: nothing reads a form's request by its order_ref. Every read,
 * cancel and settle goes through the row's own stored request ids (`paymentRequestId`,
 * `stripeSessionId`), and a callback is only a trigger naming the submission. Parsed back by
 * core-service's `parseLydiaOrderRef`, which still accepts the legacy `form:<submissionId>` of the
 * requests issued before this change.
 */
export function formOrderRef(
  submissionId: string,
  attemptId: string = randomBytes(ATTEMPT_HEX_DIGITS / 2).toString('hex')
): string {
  return `form:${submissionId}:${attemptId}`;
}
