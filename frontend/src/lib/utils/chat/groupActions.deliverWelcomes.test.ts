import { deliverWelcomes } from './groupActions';
import { createMlsServiceStub } from '$lib/mls-client/test/fixtures/mlsServiceStub';

const noopLog = () => {};

describe('deliverWelcomes', () => {
  it('delivers to every added device in parallel and returns the owner set', async () => {
    const mlsService = createMlsServiceStub();
    const bulk = {
      welcome: new Uint8Array([1]),
      ratchetTree: new Uint8Array([2]),
      addedDeviceIds: ['dev-a1', 'dev-a2', 'dev-b1'],
    };
    const owners: Record<string, string> = {
      'dev-a1': 'alice',
      'dev-a2': 'alice',
      'dev-b1': 'bob',
    };

    const delivered = await deliverWelcomes({
      mlsService,
      groupId: 'g1',
      bulk,
      ownerOf: (did) => owners[did],
      tag: '[TEST]',
      log: noopLog,
    });

    expect(delivered).toEqual(new Set(['alice', 'bob']));
    expect(mlsService.sendWelcome).toHaveBeenCalledTimes(3);
    expect(mlsService.sendWelcome).toHaveBeenCalledWith(
      bulk.welcome,
      'bob',
      'g1',
      'dev-b1',
      bulk.ratchetTree
    );
  });

  it('keeps delivering when one device fails and excludes failed-only owners', async () => {
    const sendWelcome = vi
      .fn()
      .mockImplementation((_w: Uint8Array, _u: string, _g: string, did: string) =>
        did === 'dev-b1' ? Promise.reject(new Error('delivery down')) : Promise.resolve()
      );
    const mlsService = createMlsServiceStub({ sendWelcome });
    const owners: Record<string, string> = { 'dev-a1': 'alice', 'dev-b1': 'bob' };

    const delivered = await deliverWelcomes({
      mlsService,
      groupId: 'g1',
      bulk: { welcome: new Uint8Array([1]), addedDeviceIds: ['dev-a1', 'dev-b1'] },
      ownerOf: (did) => owners[did],
      tag: '[TEST]',
      log: noopLog,
    });

    expect(delivered).toEqual(new Set(['alice']));
    expect(sendWelcome).toHaveBeenCalledTimes(2);
  });

  it('returns an empty set without sending when the bulk result has no welcome', async () => {
    const mlsService = createMlsServiceStub();

    const delivered = await deliverWelcomes({
      mlsService,
      groupId: 'g1',
      bulk: { addedDeviceIds: ['dev-a1'] },
      ownerOf: () => 'alice',
      tag: '[TEST]',
      log: noopLog,
    });

    expect(delivered.size).toBe(0);
    expect(mlsService.sendWelcome).not.toHaveBeenCalled();
  });

  it('skips devices whose owner cannot be resolved', async () => {
    const mlsService = createMlsServiceStub();

    const delivered = await deliverWelcomes({
      mlsService,
      groupId: 'g1',
      bulk: { welcome: new Uint8Array([1]), addedDeviceIds: ['dev-a1', 'dev-orphan'] },
      ownerOf: (did) => (did === 'dev-a1' ? 'alice' : undefined),
      tag: '[TEST]',
      log: noopLog,
    });

    expect(delivered).toEqual(new Set(['alice']));
    expect(mlsService.sendWelcome).toHaveBeenCalledTimes(1);
  });
});
