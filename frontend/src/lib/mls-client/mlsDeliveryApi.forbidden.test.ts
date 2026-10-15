import { describe, expect, it, vi } from 'vitest';
import {
  ExclusionsRefusedError,
  MlsDeliveryApi,
  SendEdgeRefusedError,
  SendForbiddenError,
  SenderNotActiveError,
} from './mlsDeliveryApi';
import { classifyOutgoingSendError } from './mlsSendError';
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

/**
 * THE EXCLUSIONS READ IS CLASSIFIED AT THE THROW TOO (third review of #1878). An untyped
 * `Error('getGroupExclusions failed: 403')` was a blip to every reader, so a roster-less device's
 * replies were held for good and the roster repair never ran.
 */
describe('getGroupExclusions on a refusal', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });
  const json = (status: number) =>
    new Response(JSON.stringify({ message: 'no' }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('a gateway 403 is an answer about the ROSTER - typed, and never read as a send refusal', async () => {
    // The route refuses on the roster alone; a device `active` but roster-less sends freely. Read as
    // `sender-not-active`, it ran the roster repair - which forgets the tree - on a healthy device
    // (fourth review of #1878).
    const failure = await api(json(403))
      .getGroupExclusions('g1')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ExclusionsRefusedError);
    expect(failure).not.toBeInstanceOf(SenderNotActiveError);
    expect(classifyOutgoingSendError(failure)).toBe('unknown');
    expect(refusalStatus(failure)).toBe(403);
  });

  it('an edge 403 is the network path, never the roster', async () => {
    const failure = await api(
      new Response('<html>ban</html>', { status: 403, headers: { 'content-type': 'text/html' } })
    )
      .getGroupExclusions('g1')
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(SendEdgeRefusedError);
    expect(failure).not.toBeInstanceOf(SenderNotActiveError);
  });

  it('any other status carries it as a field', async () => {
    const failure = await api(json(503))
      .getGroupExclusions('g1')
      .catch((e: unknown) => e);

    expect(refusalStatus(failure)).toBe(503);
    expect(classifyOutgoingSendError(failure)).toBe('unknown');
  });
});

describe('submitCommit declares whom the commit removes', () => {
  it('sends `removes` when there are any, and omits the field otherwise', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ accepted: true })));
    const delivery = new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await delivery.submitCommit('g1', 5, 'AAAA', undefined, undefined, undefined, [
      { userId: 'user-b' },
    ]);
    await delivery.submitCommit('g1', 5, 'AAAA');

    const bodyOf = (i: number) => JSON.parse(String(fetchImpl.mock.calls[i][1].body));
    expect(bodyOf(0).removes).toEqual([{ userId: 'user-b' }]);
    expect(bodyOf(1)).not.toHaveProperty('removes');
  });
});
