import { describe, expect, it, vi } from 'vitest';
import {
  conformPluginFetch,
  isTransportFailure,
  TransportFailureError,
} from '$lib/utils/transportFailure';
import { RequestDeadlineError } from '$lib/utils/requestDeadline';
import { DeliveryUnreachableError } from '$lib/mls-client/mlsDeliveryApi';

/**
 * ONE ANSWER TO "DID THIS REQUEST GET AN ANSWER", BY TYPE. The Mi 9T reading of `v1.2.7-alpha.1`
 * (2026-10-14): Tauri `plugin-http` rejected the `online` event's community listing with the bare
 * string `error sending request for url (...)`, which no consumer recognised as a network failure,
 * and the listing gave up as `non-retryable` for 2.5 min while the device was online.
 */
const REQWEST =
  'error sending request for url (https://canari.emse.fr/api/channels/workspaces/user/me)';

describe('isTransportFailure', () => {
  it('reads the TypeError a browser fetch throws when it reached nobody', () => {
    expect(isTransportFailure(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('reads a deadline expiry as the absence of an answer', () => {
    expect(isTransportFailure(new RequestDeadlineError('read', 20_000, 'GET', '/x', 0))).toBe(true);
  });

  it('reads the typed plugin failure and the delivery client failure as the same fact', () => {
    expect(isTransportFailure(new TransportFailureError(REQWEST))).toBe(true);
    expect(isTransportFailure(new DeliveryUnreachableError(REQWEST))).toBe(true);
  });

  it('never reads a sentence: a message that SAYS network is not a transport failure', () => {
    expect(isTransportFailure(new Error('Failed to fetch'))).toBe(false);
    expect(isTransportFailure(new Error('NetworkError when attempting to fetch'))).toBe(false);
    expect(isTransportFailure(REQWEST)).toBe(false);
  });

  it('does not treat a server answer as a connectivity problem', () => {
    expect(isTransportFailure(new Error('Token refresh failed (HTTP 502)'))).toBe(false);
    expect(isTransportFailure('not an error')).toBe(false);
  });
});

describe('conformPluginFetch - the plugin rejects the way the fetch contract says', () => {
  it('types the reqwest STRING as a TransportFailureError carrying it as cause', async () => {
    const plugin = vi.fn().mockRejectedValue(REQWEST);
    const failure = await conformPluginFetch(plugin)('https://x/api').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportFailureError);
    expect(failure).toBeInstanceOf(TypeError);
    expect((failure as TransportFailureError).cause).toBe(REQWEST);
    expect(isTransportFailure(failure)).toBe(true);
  });

  it('types a plugin Error that is not a TypeError (a scope refusal) the same way', async () => {
    const raw = new Error('url not allowed on the configured scope');
    const plugin = vi.fn().mockRejectedValue(raw);
    const failure = await conformPluginFetch(plugin)('https://x/api').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TransportFailureError);
    expect((failure as TransportFailureError).cause).toBe(raw);
  });

  it("turns the plugin's `Request cancelled` into the signal's AbortError, never a transport failure", async () => {
    const ctrl = new AbortController();
    const plugin = vi.fn().mockImplementation(async () => {
      ctrl.abort();
      throw new Error('Request cancelled');
    });
    const failure = await conformPluginFetch(plugin)('https://x/api', {
      signal: ctrl.signal,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(DOMException);
    expect((failure as DOMException).name).toBe('AbortError');
    expect(isTransportFailure(failure)).toBe(false);
  });

  it('passes an answer through untouched, whatever its status', async () => {
    const res = new Response('no', { status: 503 });
    const plugin = vi.fn().mockResolvedValue(res);
    await expect(conformPluginFetch(plugin)('https://x/api')).resolves.toBe(res);
  });

  it('passes a TypeError through as it is - it already honours the contract', async () => {
    const raw = new TypeError('Failed to fetch');
    const plugin = vi.fn().mockRejectedValue(raw);
    await expect(conformPluginFetch(plugin)('https://x/api')).rejects.toBe(raw);
  });
});
