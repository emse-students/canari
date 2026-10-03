import { fetchActivePaymentProvider, type PaymentProviderId } from '$lib/associations/api';

/**
 * The platform's active payment provider, shared by every screen that asks whether an association
 * can take money. It is server configuration, so it is fetched once per page load.
 *
 * `current` stays `null` until known and when the fetch fails - which reads as "not ready" and says
 * so at error level, rather than guessing Stripe and showing a Lydia association as incomplete.
 */
export const activePaymentProvider = $state<{ current: PaymentProviderId | null }>({
  current: null,
});

let inFlight: Promise<void> | null = null;

/** Loads the provider once; a failed load may be retried by the next caller. */
export function loadActivePaymentProvider(): Promise<void> {
  if (activePaymentProvider.current) return Promise.resolve();
  inFlight ??= fetchActivePaymentProvider()
    .then((provider) => {
      activePaymentProvider.current = provider;
    })
    .catch((err: unknown) => {
      console.error('[Payments] Could not load the active payment provider:', err);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
