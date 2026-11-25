## P2 - a released form payment resumes on the same answer, and a cash hold is announced before it expires (owner, 2026-11-21)

target: 1.8.2

_2026-11-25: moved to 1.8.2 when 1.8.1 shipped._

**Why.** Production, 2026-11-21 (read-only): of 120 answers that involved a payment, 24 were
cancelled or expired (20%, on three forms), with no way for the member to pay the same answer again;
15 chose cash, 3 cash holds expired with nobody told. Owner decision of 2026-11-21: launch now,
"payment resume" (and no opens counter: "Non, pas maintenant").

**Built in the pull request that adds this file** (feat/forms-resume-payment): the "Reprendre le
paiement" card on the form page and `POST forms/submissions/:id/resume-payment` (a NEW Lydia request
for the SAME answer, idempotent from the row, never two payable requests), and the one bell notice
`form_cash_expiring` before a cash hold expires (migration 179, no push, client floor `1.8.0`). The
notice is CLAIMED on the row (`cashReminderNotifiedAt`) whatever the member's client version,
so a member on a client older than `1.8.0` (which does not render `form_cash_expiring`) is marked
"told" but never sees it. The
state machine and the tests are in [forms](../frontend/modules/forms.md#a-released-payment-is-resumed-on-the-same-answer-owner-decision-of-2026-11-21).

**Owed on a `1.8.0` pre-release, then this file is deleted:** a resume on dev against the Lydia
sandbox (an answer cancelled at Lydia, resumed, paid with a test card; the responses table showing
`Annulé` -> `En attente` -> `Payé` on one row), and the cash notice read in the bell on a phone (a dev
cash answer whose `cashReminderDueAt` has passed). The integration spec
(`cash-reminder.integration.spec.ts`) runs in CI's `test-social-integration` only.

**Owed in a follow-up pull request (review of #3949, item 5):** an issue whose outcome is unknown (a
timeout or a 5xx after the call was sent) is released `issue-unknown` and NOT offered for a resume, so
the resume cannot repeat it; but such a row - from a submit as well - may still have a payable request
at Lydia that it does not name. Write the order_ref (and the Business) on the row BEFORE the issuing
call, and settle such a row by it (`payments/request-state` by `orderRef` already exists for the
boutique's `product` order_refs; it needs the forms grammar), then lift the `issue-unknown` exclusion.
