import { fetchActivePaymentProvider, type PaymentProviderId } from '$lib/associations/api';

/**
 * The platform's active payment provider, shared by every screen that asks whether an association
 * can take money. It is server configuration, so it is fetched once per page load.
 *
 * `current` stays `null` until known and when the fetch fails - which reads as "not ready" and says
 * so at error level, rather than guessing a provider and showing the wrong onboarding state.
 * `failed` tells the two `null`s apart: a screen that must NAME the provider (a provider-specific
 * onboarding card) shows a loading state while `current` is null and `failed` is false, and a
 * visible error once `failed` is true - it never renders a default.
 */
export const activePaymentProvider = $state<{
  current: PaymentProviderId | null;
  failed: boolean;
}>({
  current: null,
  failed: false,
});

let inFlight: Promise<void> | null = null;

/** Loads the provider once; a failed load may be retried by the next caller. */
export function loadActivePaymentProvider(): Promise<void> {
  if (activePaymentProvider.current) return Promise.resolve();
  if (inFlight) return inFlight;
  activePaymentProvider.failed = false;
  inFlight = fetchActivePaymentProvider()
    .then((provider) => {
      activePaymentProvider.current = provider;
    })
    .catch((err: unknown) => {
      activePaymentProvider.failed = true;
      console.error('[Payments] Could not load the active payment provider:', err);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}
