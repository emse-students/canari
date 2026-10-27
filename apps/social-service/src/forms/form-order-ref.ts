import { randomUUID } from 'crypto';

/**
 * The Lydia `order_ref` of ONE payment request issued for a form answer:
 * `form:<submissionId>:<attemptId>`, 78 characters for a uuid submission id, inside the 109 Lydia
 * was measured to accept.
 *
 * WHY PER ATTEMPT: Lydia refuses a second `request/do` carrying an order_ref it has already seen
 * (error 3, "order_ref deja utilise", measured on dev 2026-10-21), and a retry REUSES the live
 * pending row (`FormsService.submit`), so the old `form:<submissionId>` made every retry of a
 * declined or cancelled payment fail at Lydia. The boutique had the same defect and the same cure
 * (`productOrderRef`, migration 101).
 *
 * The attempt id is a fresh uuid and is NOT stored: nothing reads a form's request by its order_ref.
 * Every read, cancel and settle goes through the row's own stored request ids (`paymentRequestId`,
 * `stripeSessionId`), and a callback is only a trigger naming the submission. Parsed back by
 * core-service's `parseLydiaOrderRef`, which still accepts the legacy `form:<submissionId>` of the
 * requests issued before this change.
 */
export function formOrderRef(submissionId: string, attemptId: string = randomUUID()): string {
  return `form:${submissionId}:${attemptId}`;
}
