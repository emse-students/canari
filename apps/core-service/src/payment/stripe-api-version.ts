import type Stripe from 'stripe';

/**
 * The Stripe API version every client in this service pins.
 *
 * WHY this is one exported constant and why `stripe` is pinned to an EXACT version in
 * `package.json`: the SDK types `apiVersion` as a string LITERAL matching the version that SDK
 * release was cut against, so a minor `stripe` bump does not merely allow a newer API - it makes
 * this literal stop compiling. The dependency and this value are therefore COUPLED, and the
 * coupling has to be visible.
 *
 * It became visible the hard way. The Docker images ran `npm install`, never `npm ci`, so the
 * committed lockfile was never what an image built from; a `^22.2.2` range resolved to whatever
 * was newest at build time. Nothing broke while nobody rebuilt core-service, and the day something
 * did, three files failed to compile at once over a value none of them explained.
 *
 * Raising it is a decision about PAYMENTS, not about dependencies: the API version determines
 * webhook payload shapes and object fields. Bump `stripe` and this constant together, deliberately,
 * and read Stripe's changelog for the versions crossed.
 */
export const STRIPE_API_VERSION = '2026-06-24.dahlia' satisfies Stripe.StripeConfig['apiVersion'];
