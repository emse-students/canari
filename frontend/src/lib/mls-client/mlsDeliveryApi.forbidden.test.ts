import { describe, expect, it, vi } from 'vitest';
import {
  MlsDeliveryApi,
  SendEdgeRefusedError,
  SendForbiddenError,
  SenderNotActiveError,
} from './mlsDeliveryApi';
import { refusalStatus } from '$lib/utils/apiRefusal';

/**
 * A 403 ON A SEND IS CLASSIFIED AT THE THROW. `sender_not_active` keeps its own type (a Welcome
 * lifts it); every other 403 is the caller refused outright (`AUTHZ FAIL caller != requester`,
 * measured 2026-10-10) and carries its status as a field, so the outbox reads the type.
 */
describe('postApplicationMessage on a 403', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });

  it('raises SendForbiddenError carrying status 403 for an authorization refusal', async () => {
    const failure = await api(
      new Response(JSON.stringify({ message: 'requesterUserId does not match' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SendForbiddenError);
    expect(refusalStatus(failure)).toBe(403);
  });

  it('keeps sender_not_active as its own type', async () => {
    const failure = await api(
      new Response(JSON.stringify({ error: 'sender_not_active', status: 'pending' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SenderNotActiveError);
    expect(failure).not.toBeInstanceOf(SendForbiddenError);
  });

  it('classifies an HTML 403 (CrowdSec ban page) as an edge refusal, not an identity one', async () => {
    const failure = await api(
      new Response('<html><title>CrowdSec Ban</title></html>', {
        status: 403,
        headers: { 'content-type': 'text/html' },
      })
    )
      .postApplicationMessage('g1', 'AAAA')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SendEdgeRefusedError);
    expect(failure).not.toBeInstanceOf(SendForbiddenError);
    expect(refusalStatus(failure)).toBeNull();
  });
});
