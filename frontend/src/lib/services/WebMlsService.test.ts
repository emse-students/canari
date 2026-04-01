import { beforeEach, describe, expect, it, vi } from 'vitest';
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
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) })
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

  it('passe un AbortSignal aux fetch welcome et messages', async () => {
    const service = setupService();

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) })
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) });

    await service.fetchPendingMessages();

    const welcomeCall = fetchMock.mock.calls[0];
    const messagesCall = fetchMock.mock.calls[1];

    expect(welcomeCall[1]?.signal).toBeDefined();
    expect(messagesCall[1]?.signal).toBeDefined();
  });

  it('applique les headers auth sur welcome et ack', async () => {
    const service = setupService();

    fetchMock
      .mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue([]) })
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

    const welcomeCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/welcome/')
    );
    const ackCall = fetchMock.mock.calls.find((args) =>
      String(args[0]).includes('/api/mls-api/messages/ack')
    );

    expect((welcomeCall as any)[1].headers.Authorization).toBe('Bearer token-abc');
    expect((ackCall as any)[1].headers.Authorization).toBe('Bearer token-abc');
  });
});
