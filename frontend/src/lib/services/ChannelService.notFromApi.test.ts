import { ChannelService } from './ChannelService';
import { NotFromApiError } from '$lib/utils/apiJson';
import { isTransportFailure } from '$lib/utils/transportFailure';

/**
 * The key-group base travels through social-service, and a captive portal's `200 text/html` on it
 * is NO ANSWER (`NotFromApiError`, a transport failure) - never a `{ stored }` verdict and never a
 * distribution group, which used to surface as a bare `SyntaxError` nothing classified.
 */
describe('ChannelService - the distribution group-info transport reads who answered', () => {
  const portal = () =>
    new Response('<html>Sign in to use this network</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  const scope = { kind: 'workspace', workspaceId: 'w1' } as const;

  /** A service whose authenticated fetch answers `answer` - the transport under test. */
  const serviceAnswering = (answer: () => Response) => {
    const svc = new ChannelService();
    vi.spyOn(
      svc as unknown as { fetchWithAuth: (url: string) => Promise<Response> },
      'fetchWithAuth'
    ).mockImplementation(async () => answer());
    return svc;
  };

  it('a portal 200 on the publish is no answer', async () => {
    const failure = await serviceAnswering(portal)
      .publishDistributionGroupInfo(scope, 'AAAA', 3, 'd1')
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect(isTransportFailure(failure)).toBe(true);
  });

  it('a portal 200 on the fetch is no answer', async () => {
    const failure = await serviceAnswering(portal)
      .getDistributionGroup(scope)
      .catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
  });

  it("the service's JSON is still its verdict", async () => {
    const svc = serviceAnswering(() => Response.json({ stored: false }));
    await expect(svc.publishDistributionGroupInfo(scope, 'AAAA', 3, 'd1')).resolves.toEqual({
      stored: false,
    });
  });
});
