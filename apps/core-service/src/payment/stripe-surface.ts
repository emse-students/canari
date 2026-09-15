import type Stripe from 'stripe';

/**
 * THE STRIPE SURFACE THIS SERVICE ACTUALLY USES, DECLARED SO THE COMPILER CHECKS IT AGAINST THE API
 * VERSION BEING SENT.
 *
 * WHY IT IS A SOURCE FILE AND NOT PART OF ITS OWN SPEC, which is where it was first written and
 * where it proved nothing. `ts-jest` runs here without diagnostics, so a `satisfies` inside a
 * `*.spec.ts` is ERASED rather than checked - the falsification measured it: poisoning the lists
 * with `checkout.session.vanished` and a field name Stripe has never had left the suite green on
 * every type assertion and red only on the two runtime counts. `tsconfig.build.json` excludes
 * every `.spec.ts` as well, so nothing anywhere compiled those lines. A pin nothing checks is worse
 * than no pin, because it reads like a guarantee. Here, `nest build` is the checker - the same
 * command, in the same CI job, that already fails when `STRIPE_API_VERSION` stops matching the SDK.
 *
 * WHAT MAKES THE CHECK REAL, and it is the one structural fact worth knowing about stripe-node: the
 * SDK's types are CUT AGAINST ONE API VERSION. `Stripe.StripeConfig` types `apiVersion` as a string
 * LITERAL, and every object type is that version's shape. So `satisfies readonly (keyof
 * Stripe.Checkout.Session)[]` is not documentation - it is the compiler reading the NEW version's
 * schema and saying whether the field this service reads is still in it.
 *
 * SO A STRIPE BUMP NOW FAILS IN ONE OF THREE LEGIBLE PLACES instead of merging quietly:
 *   - `stripe-api-version.ts` stops compiling, because the literal moved. That is the DECISION,
 *     and it is taken by hand in the same commit.
 *   - a list here stops compiling, because a field or an event this service reads left the schema.
 *   - a fixture in `stripe-surface.spec.ts` goes red, because a payload shape changed under a
 *     branch.
 *
 * WHAT IT DOES NOT PROVE, said plainly so nobody reads more into a green run: it cannot see a change
 * in Stripe's BEHAVIOUR that keeps every shape - a field that starts arriving null, an event that
 * stops being sent. Stripe's own contract covers that half: since `2024-09-30.acacia` the monthly
 * releases inside a train are additive, and only the version that OPENS a train
 * (`2026-03-25.dahlia` for this one) carries breaking changes. Crossing INTO a new train is
 * therefore a different act from crossing within one, and nothing here pretends otherwise.
 *
 * These lists are exported and consumed by `stripe-surface.spec.ts`, which asserts a fixture exists
 * for every event named here - so neither half can be extended alone.
 */

/**
 * Every event type `webhook.controller.ts` branches on.
 *
 * Pinned against `Stripe.Event['type']` rather than `string`, so an event this service acts on that
 * a new API version renames or withdraws is a compile error - which is the one place that fact is
 * cheap to find.
 */
export const HANDLED_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_failed',
  'payment_intent.payment_failed',
  'account.updated',
] as const satisfies readonly Stripe.Event['type'][];

/** Fields read off a `Checkout.Session` - by the webhook branches and by the provider's reads. */
export const CHECKOUT_SESSION_FIELDS = [
  'id',
  'metadata',
  'customer',
  'amount_total',
  'payment_intent',
  'url',
  'payment_status',
] as const satisfies readonly (keyof Stripe.Checkout.Session)[];

/** Fields read off a `PaymentIntent` - the failure branch, and the saved-card charge. */
export const PAYMENT_INTENT_FIELDS = [
  'id',
  'metadata',
  'status',
  'client_secret',
] as const satisfies readonly (keyof Stripe.PaymentIntent)[];

/** Fields read off an `Account` - the onboarding completion branch and the Connect status reads. */
export const ACCOUNT_FIELDS = [
  'id',
  'metadata',
  'charges_enabled',
  'details_submitted',
  'type',
] as const satisfies readonly (keyof Stripe.Account)[];

/** Fields read off a `Balance` - the Connect balance summary. */
export const BALANCE_FIELDS = [
  'available',
  'pending',
] as const satisfies readonly (keyof Stripe.Balance)[];

/** Fields read off a `PaymentMethod` and its card - the saved-card list a member sees. */
export const PAYMENT_METHOD_FIELDS = [
  'id',
  'card',
] as const satisfies readonly (keyof Stripe.PaymentMethod)[];

export const PAYMENT_METHOD_CARD_FIELDS = [
  'brand',
  'last4',
  'exp_month',
  'exp_year',
] as const satisfies readonly (keyof Stripe.PaymentMethod.Card)[];

/**
 * Every SDK call this service makes, as `[resource, method]`.
 *
 * Asserted at RUNTIME by the spec against a real client rather than by type, because a resource
 * dropped from the SDK is an absence and an absence is what a `keyof` reads straight past.
 * `users.service.ts` contributes exactly one - `customers.del`, on account deletion - and it is
 * here rather than beside its call so that "what this service asks Stripe to do" is ONE list.
 */
export const SDK_CALLS: readonly (readonly [string, string])[] = [
  ['accounts', 'create'],
  ['accounts', 'retrieve'],
  ['accounts', 'createLoginLink'],
  ['accountLinks', 'create'],
  ['balance', 'retrieve'],
  ['customers', 'create'],
  ['customers', 'retrieve'],
  ['customers', 'del'],
  ['paymentIntents', 'create'],
  ['paymentMethods', 'list'],
  ['paymentMethods', 'detach'],
];
