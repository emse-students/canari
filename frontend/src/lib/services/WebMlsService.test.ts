import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/stores/auth', () => ({
  getToken: vi.fn(async () => 'token-abc'),
}));

import { WebMlsService } from './WebMlsService';

describe('WebMlsService.fetchPendingMessages', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  function setupService(): WebMlsService {
    const service = new WebMlsService();
    (service as any).userId = 'jolan';
    (service as any).deviceId = 'dev-1';
    (service as any).historyUrl = 'http://history.local';
    (service as any).authToken = 'token-abc';
    service.onMessage(async () => true);
    return service;
  }

  it('utilise msg._id comme fallback pour ACK quand msg.id est absent', async () => {
    const service = setupService();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            _id: 'legacy-123',
            senderId: 'alice',
            groupId: 'g-1',
            proto: btoa('abc'),
            isWelcome: false,
          },
        ]),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    await service.fetchPendingMessages();

    const ackCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/ack')
    );
    expect(ackCall).toBeTruthy();
    const ackBody = JSON.parse(String((ackCall as any)[1].body));
    expect(ackBody.messageIds).toEqual(['legacy-123']);
  });

  it('passe un AbortSignal au fetch messages', async () => {
    const service = setupService();

    fetchMock.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) });

    await service.fetchPendingMessages();

    const messagesCall = fetchMock.mock.calls[0];

    expect(messagesCall[1]?.signal).toBeDefined();
  });

  it('log un diagnostic explicite quand aucun pending message n est trouve', async () => {
    const service = setupService();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    fetchMock.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) });

    await service.fetchPendingMessages();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[MSG][PENDING] No pending MLS'));

    logSpy.mockRestore();
  });

  it("ne soumet pas d'ACK pour un message dont le traitement a echoue (callback retourne false)", async () => {
    const service = new WebMlsService();
    (service as any).userId = 'jolan';
    (service as any).deviceId = 'dev-1';
    (service as any).historyUrl = 'http://history.local';
    (service as any).authToken = 'token-abc';
    // callback retourne false → traitement échoué
    service.onMessage(async () => false);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue([
        {
          id: 'msg-fail',
          senderId: 'alice',
          groupId: 'g-1',
          proto: btoa('abc'),
        },
      ]),
    });

    await service.fetchPendingMessages();

    const ackCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/ack')
    );
    expect(ackCall).toBeUndefined();
  });

  it('applique les headers auth sur messages et ack', async () => {
    const service = setupService();

    fetchMock
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

    const messagesCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/jolan/dev-1')
    );
    const ackCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/ack')
    );

    expect((messagesCall as any)[1].headers.Authorization).toBe('Bearer token-abc');
    expect((ackCall as any)[1].headers.Authorization).toBe('Bearer token-abc');
  });
});
