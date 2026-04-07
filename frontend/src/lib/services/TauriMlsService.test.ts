import { beforeEach, describe, expect, it, vi } from 'vitest';

const tauriFetchMock = vi.fn();

vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: (...args: unknown[]) => tauriFetchMock(...args),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { TauriMlsService } from './TauriMlsService';

describe('TauriMlsService welcome and pending flows', () => {
  beforeEach(() => {
    tauriFetchMock.mockReset();
  });

  function setupService(): TauriMlsService {
    const service = new TauriMlsService();
    (service as any).userId = 'jolan';
    (service as any).deviceId = 'dev-1';
    (service as any).historyUrl = 'http://history.local';
    (service as any).authToken = 'token-abc';
    service.onMessage(async () => true);
    return service;
  }

  it('applique les headers auth sur messages et ack en pending fetch', async () => {
    const service = setupService();

    tauriFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            id: 'msg-1',
            senderId: 'alice',
            groupId: 'g-1',
            proto: btoa('abc'),
          },
        ]),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await service.fetchPendingMessages();

    const messagesCall = tauriFetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/jolan/dev-1')
    );
    const ackCall = tauriFetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/ack')
    );

    expect((messagesCall as any)[1].headers.Authorization).toBe('Bearer token-abc');
    expect((ackCall as any)[1].headers.Authorization).toBe('Bearer token-abc');
  });

  it('log un diagnostic explicite quand aucun pending message n est trouve', async () => {
    const service = setupService();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    tauriFetchMock.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) });

    await service.fetchPendingMessages();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[MSG][PENDING] No pending MLS'));

    logSpy.mockRestore();
  });

  it('utilise les headers auth pour fetchUserDevices', async () => {
    const service = setupService();

    tauriFetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          deviceId: 'dev-2',
          keyPackage: btoa('kp'),
        },
      ]),
    });

    const devices = await service.fetchUserDevices('alice');

    expect(devices).toHaveLength(1);
    expect(tauriFetchMock).toHaveBeenCalledWith(
      'http://history.local/api/mls-api/devices/alice',
      expect.objectContaining({ headers: { Authorization: 'Bearer token-abc' } })
    );
  });

  it('en fallback REST, sendWelcome resolve le device cible et envoie avec auth', async () => {
    const service = setupService();

    tauriFetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([{ deviceId: 'dev-alice-1', keyPackage: btoa('kp') }]),
      })
      .mockResolvedValueOnce({ ok: true, status: 200, statusText: 'OK' });

    await service.sendWelcome(new Uint8Array([1, 2, 3]), 'alice', 'g-1');

    const welcomeCall = tauriFetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/welcome')
    );
    expect(welcomeCall).toBeTruthy();
    expect((welcomeCall as any)[1].headers.Authorization).toBe('Bearer token-abc');

    const body = JSON.parse(String((welcomeCall as any)[1].body));
    expect(body.targetDeviceId).toBe('dev-alice-1');
    expect(body.targetUserId).toBe('alice');
    expect(body.groupId).toBe('g-1');
  });
});
