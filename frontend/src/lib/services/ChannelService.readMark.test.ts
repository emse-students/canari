import { ChannelService, ChannelApiError } from './ChannelService';
import { SalonGoneError } from '$lib/utils/chat/salonGoneError';

/** `advanceReadMark` types "the salon is gone" on status AND the server's code, never on status alone. */
describe('ChannelService.advanceReadMark - the gone classification', () => {
  function serviceAnswering(status: number, body: string): ChannelService {
    const svc = new ChannelService();
    vi.spyOn(
      svc as unknown as { fetchWithAuth: () => Promise<Response> },
      'fetchWithAuth'
    ).mockResolvedValue(new Response(body, { status }));
    return svc;
  }

  it('a 404 with CHANNEL_NOT_FOUND is a SalonGoneError', async () => {
    const svc = serviceAnswering(404, JSON.stringify({ code: 'CHANNEL_NOT_FOUND' }));
    await expect(svc.advanceReadMark('channel_a', 1)).rejects.toBeInstanceOf(SalonGoneError);
  });

  it('a bare 404 (proxy, deploy window, renamed route) is an ordinary refusal that keeps the mark', async () => {
    const bare = serviceAnswering(404, JSON.stringify({ message: 'Cannot POST' }));
    const error = await bare.advanceReadMark('channel_a', 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelApiError);
    expect(error).not.toBeInstanceOf(SalonGoneError);
    const html = serviceAnswering(404, '<html>nginx</html>');
    await expect(html.advanceReadMark('channel_a', 1)).rejects.not.toBeInstanceOf(SalonGoneError);
  });
});
