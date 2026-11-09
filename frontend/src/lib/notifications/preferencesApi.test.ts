// @vitest-environment happy-dom
import { NotFromApiError } from '$lib/utils/apiJson';
import { isTransportFailure } from '$lib/utils/transportFailure';

const apiFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
}));
vi.mock('$lib/services/ChannelService', () => ({ channelService: {} }));

import {
  saveDisabledCategories,
  saveGroupCallsAllowed,
  saveGroupNotificationLevel,
} from './preferencesApi';

const G = '11111111-2222-3333-4444-555555555555';

/** A captive portal answers every request `200 text/html`: the preference reached no server. */
const portal = () =>
  new Response('<html>Sign in to use this network</html>', {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });

const WRITES: Array<[string, () => Promise<void>, () => Response]> = [
  [
    'the per-conversation call permission',
    () => saveGroupCallsAllowed(G, false),
    () => Response.json({ groupId: G, allowed: false }),
  ],
  [
    'the per-conversation level',
    () => saveGroupNotificationLevel(G, 'mentions'),
    () => Response.json({ groupId: G, level: 'mentions' }),
  ],
  [
    'the disabled categories',
    () => saveDisabledCategories([]),
    () => Response.json({ disabled: [] }),
  ],
];

describe('a notification preference is saved only on the delivery service answer', () => {
  beforeEach(() => apiFetch.mockReset());

  it.each(WRITES)('%s: a portal 200 saved nothing, a transport failure', async (_n, save) => {
    apiFetch.mockResolvedValueOnce(portal());
    const failure = await save().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect(isTransportFailure(failure)).toBe(true);
  });

  it.each(WRITES)("%s: the service's JSON 200 is saved", async (_n, save, answer) => {
    apiFetch.mockResolvedValueOnce(answer());
    await expect(save()).resolves.toBeUndefined();
  });
});
