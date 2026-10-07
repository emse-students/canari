import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchActivePaymentProvider = vi.fn();
vi.mock('$lib/associations/api', () => ({ fetchActivePaymentProvider }));

/**
 * THE PROVIDER IS KNOWN, LOADING OR FAILED - NEVER GUESSED.
 *
 * The association edit page used to default to `stripe` until the fetch answered, so a deep link to
 * the payments tab of a Lydia platform drew the Stripe card and its button hit a 400. These cases
 * pin the three states a screen may branch on.
 */
describe('activePaymentProvider', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchActivePaymentProvider.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('is unknown and not failed before anything asked', async () => {
    const { activePaymentProvider } = await import('./activePaymentProvider.svelte');
    expect(activePaymentProvider.current).toBeNull();
    expect(activePaymentProvider.failed).toBe(false);
  });

  it('stays unknown WITHOUT being failed while the fetch is pending', async () => {
    fetchActivePaymentProvider.mockReturnValue(new Promise(() => {}));
    const { activePaymentProvider, loadActivePaymentProvider } =
      await import('./activePaymentProvider.svelte');
    void loadActivePaymentProvider();
    expect(activePaymentProvider.current).toBeNull();
    expect(activePaymentProvider.failed).toBe(false);
  });

  it('holds what the server answered', async () => {
    fetchActivePaymentProvider.mockResolvedValue('lydia');
    const { activePaymentProvider, loadActivePaymentProvider } =
      await import('./activePaymentProvider.svelte');
    await loadActivePaymentProvider();
    expect(activePaymentProvider.current).toBe('lydia');
    expect(activePaymentProvider.failed).toBe(false);
  });

  it('a failed fetch is FAILED, never a default, and a retry may recover', async () => {
    fetchActivePaymentProvider.mockRejectedValueOnce(new Error('provider 500'));
    const { activePaymentProvider, loadActivePaymentProvider } =
      await import('./activePaymentProvider.svelte');
    await loadActivePaymentProvider();
    expect(activePaymentProvider.current).toBeNull();
    expect(activePaymentProvider.failed).toBe(true);

    fetchActivePaymentProvider.mockResolvedValueOnce('stripe');
    await loadActivePaymentProvider();
    expect(activePaymentProvider.current).toBe('stripe');
    expect(activePaymentProvider.failed).toBe(false);
  });
});
