import { describe, expect, it, vi } from 'vitest';
import { MlsDeliveryApi } from './mlsDeliveryApi';
import { refusalCode, refusalStatus } from '$lib/utils/apiRefusal';

/**
 * A REFUSED KEY PACKAGE PUBLISH, DEVICE UPDATE AND COMMIT SUBMISSION ARE TYPED AT THE THROW.
 *
 * They threw `new Error('... failed: <status>')`, so a 413 and a 503 differed only in prose. They
 * now throw an `ApiRefusalError`: the status always, the server's `code` when its JSON body has one.
 */
describe('delivery refusals carry status and code', () => {
  const api = (res: Response) =>
    new MlsDeliveryApi({
      historyUrl: 'https://example.test',
      getToken: async () => 'token',
      fetchImpl: vi.fn().mockResolvedValue(res) as unknown as typeof fetch,
    });
  const refused = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const pk = { bytes: new Uint8Array([1, 2, 3]), notAfterSecs: 1 };

  it('key package publish', async () => {
    const e = await api(refused(429, { code: 'RATE_LIMITED' }))
      .publishKeyPackages([pk])
      .catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(429);
    expect(refusalCode(e)).toBe('RATE_LIMITED');
  });

  it('device metadata update', async () => {
    const e = await api(refused(404, {}))
      .updateDeviceMetadata('u1', 'd1', { deviceName: 'x' })
      .catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(404);
    expect(refusalCode(e)).toBeNull();
  });

  it('commit submission', async () => {
    const e = await api(refused(403, { code: 'NOT_A_MEMBER' }))
      .submitCommit('g1', 0, 'AAAA')
      .catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(403);
    expect(refusalCode(e)).toBe('NOT_A_MEMBER');
  });

  it('commit replay, with an edge page that carries no code', async () => {
    const e = await api(new Response('<html>ban</html>', { status: 502 }))
      .fetchCommitsSince('g1', 0)
      .catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(502);
    expect(refusalCode(e)).toBeNull();
  });

  it.each([
    ['rename', (a: MlsDeliveryApi) => a.renameGroup('g1', 'n')],
    ['group image', (a: MlsDeliveryApi) => a.setGroupImage('g1', null)],
    ['group members', (a: MlsDeliveryApi) => a.getGroupMembers('g1')],
    ['user groups', (a: MlsDeliveryApi) => a.getUserGroups('u1')],
    ['kick of a stale device', (a: MlsDeliveryApi) => a.kickStaleDevice('d1', 'u1', 'g1')],
  ])('%s: a refusal is typed with status and code', async (_name, call) => {
    const e = await call(api(refused(409, { code: 'CONFLICT_X' }))).catch((x: unknown) => x);
    expect(refusalStatus(e)).toBe(409);
    expect(refusalCode(e)).toBe('CONFLICT_X');
  });
});
