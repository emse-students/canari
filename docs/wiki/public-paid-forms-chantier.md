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
| PP3 | An unpaid pending answer | **It expires from its own row**, for ALL forms: a delay from `createdAt` (about 30 minutes, to be measured against Lydia's payment window), after which it no longer counts toward `maxSubmissions` and an idempotent job removes it, on the model of cash expiry. **Measured 2026-10-15: no code expires an online `pending` submission today** (`forms.service.ts` counts `pending` toward the cap and nothing releases it), so this also fixes a defect members already have, and it closes the hole a robot would use on a public form (no dedupe: `allowMultipleSubmissions` is forced). |
| PP4 | A payment arriving after expiry | **Validated if room remains, otherwise flagged to the organiser for a refund.** Expiry releases only the SEAT, not the trace of the payment: the row becomes "expired" and stays findable by its reference. A late payment makes it "paid" while the cap is not reached, else "paid outside capacity", shown at the top of the responses with the amount. The organiser refunds outside the application: **no refund mechanism exists** (no `refund` in `core-service/src/payment`, nor in `payments.md`, checked 2026-10-15). |
| PP5 | Abuse on the paid guest path | **The existing limits (30 per minute per visitor, the honeypot) plus a ceiling of 3 pending paid answers per visitor (network address) at one instant**, counted from the pending ROWS (PP3), never from a clock. A robot cannot fill the seats. A shared network (an event hall) may hit the ceiling: to evaluate. |

**The setting itself is optional and already exists** (confirmed 2026-10-15): `forms.isPublic`, default `false`
(`form.entity.ts`, migration 068), a switch in "Paramètres avancés" (`FormAdvancedSettings.svelte`). **The
switch is DISABLED today as soon as a payment or an audience is set** (`disabled={!isPublic && (requiresPayment ||
submitCondition != null)}`): that lock is lifted by this chantier, only for what a guest keeps (PP1).

## Work packages (draft)

| WP | Scope | Named starting point | Proof |
|---|---|---|---|
| **WP-P0** | Expire a pending online answer from its row (PP3, PP4), the "expired" and "paid outside capacity" states, for ALL forms; ships first because it fixes members too | `forms.service.ts` (`submit`, the capacity count), `forms-reminder.scheduler.ts` (cash expiry as the pattern), migration for the new states | A row left pending frees its seat; a late payment lands in the right state; a second job run changes nothing |
| **WP-P1** | Lift the guest refusals PP1 allows: the `submit` guest branch takes the paid path with `userId = null`, `assertPublicConfigValid` allows price, answer grid, supplements and cash, `markPaid` accepts a null user, the editor lock is lifted | `forms.service.ts`, `markPaid`, `FormAdvancedSettings.svelte` | A guest pays on dev, one real Lydia payment observed |
| **WP-P2** | The guest return page with a reference (PP2), no dependence on the session-guarded `verify-session`; the Lydia callback marks the row paid | `routes/f/[id]/`, `webhook.controller.ts`, `payment.controller.ts` | The page is read after a real payment and the row is `paid` |
| **WP-P3** | The per-visitor ceiling of pending paid answers (PP5), honeypot and throttle on the paid path | `PublicFormsController`, `ClientIpThrottlerGuard` | A script of 4 pending answers from one address is refused on the 4th |
| **WP-P4** | Correct the stale forms.md line, document the module, French guide | `docs/wiki/frontend/modules/forms.md` | - |

**All of it waits on WP-LYDIA-1 for the observed payment** (production tokens, `LYDIA_ENV`, the Livrable A answers):
the code can be written and tested on dev with Lydia's homologation account, but nothing ships to users before.
Order: P0 first (independent), then P1, P2, P3 in parallel, P4 last.

## Open

- The floor amount: 0.50 is inherited from the old processor, Lydia's own minimum is unmeasured (Livrable A).
- Rate limit and honeypot on the guest PAID path (the free path already has 30 per minute per visitor).
- The guest return page and how the Lydia callback marks a guest submission paid.
- Work packages, and what must be observed on dev before any of it ships.
