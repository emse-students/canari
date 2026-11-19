# Stripe - what it did, why it left, and the names it left behind (archive, 2026-10-08)

**Stripe left the product on 2026-10-07** (user: *"Stripe va disparaitre"*). Payments run on Lydia,
shown to members as "Paiement Canari", or on cash. Nothing in the code reads a Stripe key, calls the
Stripe API or answers a Stripe webhook any more. This page is the only record of what it did.
The live payment model is [payments](frontend/modules/payments.md).

## What it did

- **Connect onboarding.** An association linked a Stripe Connect Express account
  (`stripeAccountId`, `stripeOnboardingComplete`); the status was polled live and a dashboard link
  and a disconnect existed. Lydia has no live status poll: its account is a stored profile.
- **Checkout.** Forms and the shop created a Stripe Checkout session on the connected account, with
  `{CHECKOUT_SESSION_ID}` in the return URL. Lydia does not substitute it, so the return key is
  carried by Canari itself (`withSubmissionReturnKey`).
- **Saved cards.** A SetupIntent plus Elements stored a PaymentMethod on a per-user Stripe customer
  (`stripeCustomerId`), charged later by the "save for next time" box. Lydia has no saved methods and
  no customer object, so the whole flow went.
- **The webhook.** `POST /api/payments/webhook`, signature-verified. It verified with the
  synchronous `constructEvent`, which under `bun` takes the `worker` export condition and never
  verified (0 acceptances over the container's life, 38 events undelivered); `verify-session` was the
  repair path. Both are gone with the provider; Lydia's own `lydia-request-callback` is the only
  confirmation route left.

## What was removed (2026-10-08)

Routes (core-service): connect-status, disconnect-connect-account, connect-dashboard-link,
setup-payment-method, payment-methods GET/DELETE, internal/customer-id, charge-saved-method,
charge-product-saved-method, the Stripe webhook. social-service: the internal products controller
and the internal form-submission read that only the saved-card charge used. Dependency: `stripe`
from `apps/core-service` (`package.json`, `bun.lock`). Frontend: `PaymentModal`,
`SettingsPaymentsSection`, `stripeFees`, the Connect panels, the CSP hosts, 54 Paraglide keys per
language. CI/infra: the `STRIPE_*` env rows in `build.yml`, `serve-prod.yml`, `env-manifest.tsv`,
the compose files, `.env.example`, `env-from-prod.sh`; the harness log rule for the provider boot.
The provider choice is now `'lydia' | 'disabled'`, default `disabled`; migration
`011_platform_config_drop_stripe.sql` moves a stored `stripe` to `disabled`.

## The names that outlived the processor - what 2026-10-09 renamed, and what stays

**Renamed, nothing persisted by name** (2026-10-09): the permission `MANAGE_STRIPE_CONNECT` is now
`MANAGE_PAYOUT_ACCOUNT` - only the BIT (`1 << 9`) is stored, never the name, so no data migration was
needed (this page used to say "persisted flag"; it is the number that is). The same for
`canManagePayoutAccount`, the Paraglide key `asso_flag_manage_payout_account`, the editor right
`payoutAccount`, and the internal wire field `connectAccountId` between social and core-service (the two
deploy together). **Deleted:** the social routes `stripe-account`, `stripe-complete`, `stripe-disconnect`
(no caller since core-service lost Stripe; internal-secret only, so no client in the wild could call
them), the `stripe*` pair from the internal `payment-account` answer, and `stripeAccountId` from the
submission read (now `paymentAccountId`). **A real defect fixed with them:** the delegation state and
its approval still tested the Stripe pair, so a parent onboarded on Lydia could not approve a request;
both read `lydiaOnboardingComplete` and `lydiaAccountId` now.

**Deep-link host:** a checkout return is `fr.emse.canari://payment/...`. The `stripe` host of builds
below 1.2.4 was declared, accepted and routed until `minClientVersion` reached 1.2.7, then removed;
the test that pinned its absence went with the rest on 2026-11-19 (the host is no longer named
anywhere, and `deepLinkHostsDeclared.test.ts` still pins `payment`).

## The last removal (owner, 2026-11-19: "Tu peux tout supprimer en ce qui concerne Stripe")

**Dropped, by two held migrations** (`-- canari:hold-for-owner`, each with its count query, rollback
and lock strategy in its header; the approval lines are the lead's to merge):

| Name | Migration | Why it was safe |
| --- | --- | --- |
| `associations."stripeAccountId"`, `"stripeOnboardingComplete"` | `apps/social-service/src/migrations/177_drop_stripe_leftovers.sql` | unmapped by #1669, first shipped in `v1.2.4`: the rollback floor this sets is far below the one in force |
| `users."stripeCustomerId"` | `apps/core-service/src/migrations/027_drop_users_stripe_customer_id.sql` | unmapped by #1589, first shipped in `v1.2.0` |

The three copy strips of the dropped columns (`infrastructure/lib/copy-strips.sh`) went in the same
change. A dump taken before an estate has run 177 and 027 still carries the historic Stripe ids into
the copy; no Stripe key exists anywhere (the three GitHub secrets were already gone when listed on
2026-11-19), so nothing can address them. The legacy `dashboard/association` route stub, the CSP test
naming Stripe, the retired-host test and every comment that named Stripe only as history went too.

**The permission rename needs no data migration:** `MANAGE_STRIPE_CONNECT` became
`MANAGE_PAYOUT_ACCOUNT` on 2026-10-09, and only the bit (`1 << 9`) is stored, never the name. The
name survives only in the applied migration `004_manage_stripe_connect.sql`, which is history and is
never edited.

**What still says "stripe", and why** (a scoped grep of `apps/`, `frontend/src`, `libs/`,
`infrastructure/` and `.github/`, 2026-11-19):

| Mention | Why it stays |
| --- | --- |
| `paymentMethod = 'stripe'` stored on `purchase_records` and `submissions`, the `'stripe'` arm of `PurchasePaymentMethod` and of the client types | historic data, never written again. Live readers tell it apart: the refund target answers `not-online`, the Lydia contract flux counts only `online`, the responses table shows a paid NULL without a method; on a form-source purchase it is the only processor marker. A rewrite was written and withdrawn in review ([legacy-compatibility](legacy-compatibility.md#no-date-yet---a-stored-paymentmethod-of-stripe-written-before-the-stripe-removal)) |
| `submissions."stripeSessionId"`, `purchase_records."stripePaymentIntentId"` and every read, write, test and copy strip of them | LIVE: they hold the Lydia `request_uuid` and order reference. Renaming is expand, then contract over two releases (add `paymentRef`, backfill, read and write it, drop the old column a release later), for no functional gain; not started |
| `.github/scripts/tests/local-copy-guards.test.sh` (`(stripe\|lydia)` in its column parser) | it derives the copy strips from the entity properties, and the two live columns above are still named `stripe*` |
| `submission.projection.spec.ts`'s leak regex | it asserts that no internal column name (the live `stripeSessionId` among them) reaches a member |
| `paymentProviderCopy.test.ts`'s copy regex, `tools/store-listings/listings.mjs` and its test | they assert that member-facing copy and store texts name no removed processor or card brand |
| `session_id={CHECKOUT_SESSION_ID}` in `checkoutCallbacks.ts` and `return-url-key.ts` (the comment points here) | the placeholder every client at the floor sends; the server swaps it for `submission_id`. Changing it is a client change plus a floor-gated shim |
| The earlier migrations of social-service (004, 017, 037, 054, 057, 063, 084) and core-service (004, 011) | history: an applied migration is never edited (the ledger warns on a changed checksum) |
| 177 and 027 themselves | they name what they drop |
| `apps/core-service/README.md` | its pointer to this page |
| "striped", "a stripe" in `ProductGridQuestion`, `MonthCalendarGridRich`, `CardTile`, `calendarExport` | the English word, not the processor |

## Notes for whoever reads this next

- **The 50-cent floor** that `forms.service.ts` inherited from Stripe is gone (2026-10-21): a form
  total is now checked against Lydia's confirmed range, mirrored from core-service - see
  [payments](frontend/modules/payments.md).
- **Associations delegation.** `payment-delegation.util.ts` now reads only the Lydia columns and
  rejects a provider id it does not know, `stripe` included. An association whose delegation was
  onboarded on Stripe only is therefore not ready until it onboards on Lydia.
- **Legal copy.** The CGU and privacy pages now name Lydia and drop the US-transfer entry (approved
  by the user on 2026-10-08).

## Owed by the user (one-off)

- The GitHub secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUB_KEY`: DONE (none listed
  on 2026-11-19, repository or environment).
- Delete the webhook endpoint at Stripe and, when no refund can still be asked, close the Stripe
  account; purging the Stripe-side customers is that account's closure, nothing in this repo does it
  ([backlog](backlog.md#owed-to-the-user---decisions-rotations-and-one-off-clicks)).
