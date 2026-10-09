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

**Deep-link host, additive:** a checkout return is `fr.emse.canari://payment/...`; `stripe` stays
declared (manifest, `tauri.conf.json`), accepted by the server and routed by the client for builds that
still send it - an entry in [legacy-compatibility](legacy-compatibility.md) with its removal condition.
`deepLinkHostsDeclared.test.ts` pins both hosts in `tauri.conf.json` and the Android manifest.

**Still in the database, on purpose, and the plan that removes them:**

| Name | State | Step |
| --- | --- | --- |
| Columns `associations."stripeAccountId"` and `"stripeOnboardingComplete"`, `users."stripeCustomerId"` | no longer mapped by any entity, read and written by nothing | **DROP** in a migration once the previous release (which still maps them) is no longer a rollback target; the strips in `copy-strips.sh`, `copy-prod-to-dev.sh`, `restore-into-local.sh` go in the same change. Dropping earlier gains nothing and a rollback would crash on the missing column |
| `submissions."stripeSessionId"`, `purchase_records."stripePaymentIntentId"` | LIVE: they hold the Lydia order reference | a rename is expand, then contract: add `paymentRef`, backfill by `UPDATE`, ship code reading and writing the new column, drop the old one a release later. No measured need to rename yet, so it is not started |
| `paymentMethod: 'stripe'` on rows and in the DTO | data at rest, read as `online`, never written | [legacy-compatibility](legacy-compatibility.md) |
| `stripe` checkout host | legacy, see above | same entry |

**The rule the columns follow** ([databases](infrastructure/databases.md)): additive first, destructive
last, and a destructive migration is cut only when the release that stopped mapping the column has been
in production through a rollback window. Nothing here drops data for a name.

## Notes for whoever reads this next

- **The 50-cent floor** (`MIN_PAYMENT_CENTS = 50` in `forms.service.ts`) is Stripe's minimum, inherited.
  Lydia's minimum is not measured; it is kept until it is.
- **Associations delegation.** `payment-delegation.util.ts` now reads only the Lydia columns and
  rejects a provider id it does not know, `stripe` included. An association whose delegation was
  onboarded on Stripe only is therefore not ready until it onboards on Lydia.
- **Legal copy.** The CGU and privacy pages now name Lydia and drop the US-transfer entry. That text
  is a legal statement and needs a human review before it is trusted.

## Owed by the user (one-off)

- Delete the GitHub secrets `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUB_KEY`.
- Delete the webhook endpoint and, when no refund can still be asked, close the Stripe account;
  purging the Stripe-side customers is that account's closure, nothing in this repo does it.
