# Paid public forms - the chantier, decisions as taken

**Status: PLANNING (opened 2026-10-15), parallel to [bookings-chantier](bookings-chantier.md).** Nothing is built.

## The need, and its scope (user, 2026-10-15)

A form answered with no account that CHARGES, for example the tickets of an outside event. **The scope
is exactly "the same as a paid form internal to Canari"**: the user corrected a first draft of this
page that invented ticketing (stock, one ticket per person, QR codes). None of that is in scope. A
guest types an e-mail, which is what Lydia needs as `payerRecipient`, so the e-mail is not an obstacle.

## What a guest changes in the code, read on `main` (2026-10-15)

| Fact | Where | Consequence |
|---|---|---|
| The guest branch of `submit` stores a FREE answer and refuses any amount (`A public form cannot charge for an option`), and `assertPublicConfigValid` refuses price, grid, cash and a grant | `apps/social-service/src/forms/forms.service.ts` (`submit`, `assertPublicConfigValid`) | Both are to be lifted for what a guest CAN do |
| **`create-checkout-session` ALREADY accepts the shared internal secret** (since 2026-10-07; `payment.controller.ts` documents the 401 it used to answer) and `submit` calls it through `internalCoreRequestConfig()` | `apps/core-service/src/payment/payment.controller.ts`, `apps/social-service/src/internal/core-request.ts` | **The wiki line "social-service calls with no credential" in [forms](frontend/modules/forms.md#the-paid-half-what-it-needs-scoped-2026-09-30) is STALE**: correct it in the planning pull request. The checkout itself still needs one observed paid form on dev |
| `verify-session` is behind `NginxAuthGuard` | `payment.controller.ts` | A guest returning from Lydia cannot call it: the return page must not depend on it, and the Lydia callback (`webhook.controller.ts`) is what marks the submission paid |
| The member path writes `userId` and `email` on a `pending` submission and `markPaid` and the cotisation grant read `userId` | `forms.service.ts`, `markPaid` | Fulfilment must accept `userId = null` |
| Lydia is not live in production | [backlog WP-LYDIA-1](backlog.md) | Upstream, not code: no observed homologation payment, no production tokens, associations not re-onboarded, three Livrable A answers open (KYC documents, minimum payable amount, rate limits), and the partnership contract unsigned |

## Decisions

| # | Question | Decision |
|---|---|---|
| PP1 | What a guest may use | **Everything that needs no account** (user): base price, a price grid on ANSWER dimensions (a menu, a formula: no profile data), option supplements, and CASH validated by the association. Still refused: a grid on promo, formation or cotisation, the audience filter and the cotisation grant. The answer-grid refusal was caution, not necessity. |
| PP2 | After paying | **A confirmation page with a reference number, no e-mail.** The payer's address is never stored (a promise to Lydia: "proof the payer e-mail is not kept" is owed to them). The organiser finds the person through the answers (a "Nom Prénom" question). Known cost: a guest who closes the page early has no receipt. |
| PP3 | An unpaid pending answer | **It expires from its own row**, for ALL forms: a delay from `createdAt` (about 30 minutes, to be measured against Lydia's payment window), after which it no longer counts toward `maxSubmissions` and an idempotent job moves it to `expired` (it is NOT removed: PP4 needs the trace), on the model of cash expiry. **Measured 2026-10-15: no code expires an online `pending` submission today** (`forms.service.ts` counts `pending` toward the cap and nothing releases it), so this also fixes a defect members already have, and it closes the hole a robot would use on a public form (no dedupe: `allowMultipleSubmissions` is forced). |
| PP4 | A payment arriving after expiry | **Validated if room remains, otherwise flagged to the organiser for a refund.** Expiry releases only the SEAT, not the trace of the payment: the row becomes "expired" and stays findable by its reference. A late payment makes it "paid" while the cap is not reached, else "paid outside capacity", shown at the top of the responses with the amount. The organiser refunds outside the application: **no refund mechanism exists** (no `refund` in `core-service/src/payment`, nor in `payments.md`, checked 2026-10-15). |
| PP5 | Abuse on the paid guest path | **The existing limits (30 per minute per visitor, the honeypot) plus a ceiling of 3 pending paid answers per visitor (network address) at one instant**, counted from the pending ROWS (PP3), never from a clock. A robot cannot fill the seats. A shared network (an event hall) may hit the ceiling: to evaluate. |

**The setting itself is optional and already exists** (confirmed 2026-10-15): `forms.isPublic`, default `false`
(`form.entity.ts`, migration 068), a switch in "Paramètres avancés" (`FormAdvancedSettings.svelte`). **The
switch is DISABLED today as soon as a payment or an audience is set** (`disabled={!isPublic && (requiresPayment ||
submitCondition != null)}`): that lock is lifted by this chantier, only for what a guest keeps (PP1).

## Work packages (draft)

| WP | Scope | Named starting point | Proof |
|---|---|---|---|
| **WP-P0** (DRAFT PR #1906, 2026-10-15: built, with two changes beyond its scope that review must confirm - `submit` now locks the form row and runs in READ COMMITTED because main let 4 concurrent submits take a 1-seat form, and `markPaid` is a no-op on a row already `paid` or `paid_over_capacity` because the Lydia callback and `verify-session` both called it, re-granting the cotisation twice; migration 084 adds the request time and two durable fulfilment flags, a DATA change that needs the user's yes before any production deploy; its round two also locks cancel and cash validation and guards the replay on the request id) | Expire a pending online answer from its row (PP3, PP4), the "expired" and "paid outside capacity" states, for ALL forms; ships first because it fixes members too | `forms.service.ts` (`submit`, the capacity count), `forms-reminder.scheduler.ts` (cash expiry as the pattern), migration for the new states | A row left pending frees its seat; a late payment lands in the right state; a second job run changes nothing |
| **WP-P1** (BUILT 2026-10-22, MERGED #2229; migration 103 makes `purchase_records.userId` nullable, schema only; the real Lydia payment on dev is NOT yet observed) | Lift the guest refusals PP1 allows: the `submit` guest branch takes the paid path with `userId = null`, `assertPublicConfigValid` allows price, answer grid, supplements and cash, `markPaid` accepts a null user, the editor lock is lifted | `forms.service.ts`, `markPaid`, `FormAdvancedSettings.svelte` | A guest pays on dev, one real Lydia payment observed |
| **WP-P2** (BUILT 2026-10-22, MERGED #2230; migration 104 adds the receipt hash, schema only; a security surface - [forms](frontend/modules/forms.md#the-guests-return-from-lydia-a-receipt-not-an-id-wp-p2---a-security-surface); the page read after a REAL payment is NOT yet observed) | The guest return page with a reference (PP2), no dependence on the session-guarded `verify-session`; the Lydia callback marks the row paid | `routes/f/[id]/`, `webhook.controller.ts`, `payment.controller.ts` | The page is read after a real payment and the row is `paid` |
| **WP-P3** (BUILT 2026-10-22, MERGED #2231; migration 105 adds the visitor key, schema only; [forms](frontend/modules/forms.md#at-most-three-answers-waiting-per-visitor-wp-p3-decision-pp5); a shared address's cost is NOT measured) | The per-visitor ceiling of pending paid answers (PP5), honeypot and throttle on the paid path | `PublicFormsController`, `ClientIpThrottlerGuard` | A script of 4 pending answers from one address is refused on the 4th |
| **WP-P4** (BUILT 2026-10-22, #2232: forms.md sections written with each WP, payments.md's guest lines, [the French guide](../user-guide/formulaires-publics.md)) | Correct the stale forms.md line, document the module, French guide | `docs/wiki/frontend/modules/forms.md` | - |

WP-P4's stale forms.md line is already corrected in #1906. Guest rows (`userId = null`) go through the same `markPaid`, so a late guest payment needs no extra work in WP-P1.

**All of it waits on WP-LYDIA-1 for the observed payment** (production tokens, `LYDIA_ENV`, the Livrable A answers):
the code can be written and tested on dev with Lydia's homologation account, but nothing ships to users before.
Order: P0 first (independent), then P1, P2, P3 in parallel, P4 last.

## UNBLOCKED by Lydia's sandbox (measured 2026-10-15 by Master, docs PR #1909)

`request/do` accepts `expire_time`, an integer of SECONDS (60 s gives the expire callback at about 79 s, the sweep runs about once a minute; **0 does NOT expire**; text, negative and date values are refused) - D1. `POST /api/request/cancel.json` with the NUMERIC `request_id` and `vendor_token`, no signature, answers error 0 and state 6 and fires `cancel_url`; the `request_uuid` is refused and an already cancelled or expired request answers error 2 - D2. `request/do` also returns the numeric `request_id` the callbacks carry, so storing it makes the id comparison and the cancel possible. **A P1 stays open: the real Lydia callbacks (expire, cancel) are refused with 400 "Missing request_id or sig" before any signature check** (likely `multipart/form-data` that core-service does not parse; another session has the fix): never count on a processed callback until it is deployed, and keep the confirmation path on `verify-session`.

## Blocked on information the repository does not hold (2026-10-15, from WP-P0 round two) - RESOLVED above, kept for the story

| Point | What is missing | Who can supply it |
|---|---|---|
| D1: the Lydia request expires with the seat hold | the name and format of the `request/do` expiry parameter appear nowhere (`plans/stripe-to-lydia-migration.md`, `payments.md`, `core-service.md`, the provider code) | Lydia's documentation (the Livrable A exchange) |
| D2: reuse a pending row and cancel the old Lydia request | no cancel call is documented (only the cashier permission `access_cancelrequest`); `cancel-pending` carries no request id, so an old request's cancel callback could cancel the live one | Lydia, then the request id on the cancel callback |
| D3: tell the organiser of `paid_over_capacity` | no notification type fits (`form_reminder` links to the fill page); a NEW category needs push text, a `NotificationRow` case and a deep link | The user's approval of a new category |

Until then a row past the hold is NOT reused (a new row is written), and the replay warning is the only
trace of two payable requests. The migration numbers 084 of WP-P0 and WP-F collide: the second to
merge renumbers to 085.

## Accords recorded

User, 2026-10-15, in session (relayed by the planning session, recorded at Master's request),
covering: D1-D3, the backfill of migration 083, the data half of migration 084 before production,
`minClientVersion` 1.2.7 (the user's own action), the anonymous-form file question refused, and
Lydia states 1 (paid) and 5 (refused by the payer) to be measured by hand on the homologation payer
page. No later work package starts until the lead session says so.

## Open

- The floor amount: 0.50 is inherited from the old processor, Lydia's own minimum is unmeasured (Livrable A).
- Work packages, and what must be observed on dev before any of it ships.
