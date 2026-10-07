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

## The names that outlived the processor (kept on purpose)

A rename is not free: old APKs embed their frontend, a rollback must find its columns, and a
permission flag is persisted. Each is data or a wire name now, not behaviour.

| Name | Why it stays |
| --- | --- |
| Columns `stripeAccountId`, `stripeOnboardingComplete` (associations), `stripeCustomerId` (users) | the previous release still maps them; dropping them breaks a rollback |
| Permission `MANAGE_STRIPE_CONNECT` / `canManageStripeConnect` | persisted flag; it now gates the payout account of either provider |
| Wire field `stripeConnectAccountId` between social and core-service | both services deploy together, the name is internal |
| social routes `stripe-account`, `.../complete`, `.../disconnect` | clients in the wild call them |
| Deep-link host `stripe` (`canari://stripe/...`) | registered natively in the shipped apps |
| `paymentMethod: 'stripe'` and `PurchaseRecord.paymentMethod = 'stripe'` | every row written before 2026-10-08; read as `online`, never written again ([legacy-compatibility](legacy-compatibility.md)) |
| The `stripeCustomerId` strips in `copy-strips.sh`, `copy-prod-to-dev.sh`, `restore-into-local.sh` | the column still exists in a copied database |

**Later migration (backlog):** once the previous release is no longer a rollback target, a migration
drops the three columns and the permission is renamed with a data migration of the persisted flag,
then the routes and the deep-link host follow the same `minClientVersion` rule.

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
