import { ChannelApiError, ChannelService } from './ChannelService';
import { ReadMarkTargetGoneError } from '$lib/utils/chat/salonReadMarkQueue';

/**
 * `advanceReadMark` classifies the server's answer at the throw: ONLY `404 CHANNEL_NOT_FOUND` says
 * the salon is gone (the owed queue drops the mark on it); every other refusal stays a refusal, kept.
 */
describe('ChannelService.advanceReadMark - a salon that no longer exists', () => {
  function answering(res: Response): ChannelService {
    const svc = new ChannelService();
    vi.spyOn(
      svc as unknown as { fetchWithAuth: () => Promise<Response> },
      'fetchWithAuth'
    ).mockResolvedValue(res);
    return svc;
  }

  it('throws ReadMarkTargetGoneError on the named 404', async () => {
    const svc = answering(
      new Response(JSON.stringify({ code: 'CHANNEL_NOT_FOUND', message: 'Channel not found' }), {
        status: 404,
      })
    );
    await expect(svc.advanceReadMark('channel_gone', 100)).rejects.toBeInstanceOf(
      ReadMarkTargetGoneError
    );
  });

  it('keeps an unnamed 404 (an edge page) and a 403 as ordinary refusals', async () => {
    const edge = answering(new Response('<html>404</html>', { status: 404 }));
    await expect(edge.advanceReadMark('channel_a', 100)).rejects.toBeInstanceOf(ChannelApiError);

    const forbidden = answering(
      new Response(JSON.stringify({ message: 'Not allowed to access this channel' }), {
        status: 403,
      })
    );
    await expect(forbidden.advanceReadMark('channel_a', 100)).rejects.toBeInstanceOf(
      ChannelApiError
    );
  });
});
