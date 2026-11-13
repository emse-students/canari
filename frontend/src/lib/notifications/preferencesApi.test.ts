// @vitest-environment happy-dom
import { NotFromApiError } from '$lib/utils/apiJson';
import { isTransportFailure } from '$lib/utils/transportFailure';

const apiFetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
vi.mock('$lib/utils/apiFetch', () => ({
  apiFetch: (url: string, init?: RequestInit) => apiFetch(url, init),
}));
vi.mock('$lib/services/ChannelService', () => ({ channelService: {} }));

import {
  fetchNotificationPreferences,
  saveDisabledCategories,
  saveGroupCallsAllowed,
  saveGroupNotificationLevel,
} from './preferencesApi';
import { CLIENT_VERSION_HEADER, getClientAppVersion } from '$lib/utils/appVersion';

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

/**
 * A SAVE NEVER SWITCHES BACK ON WHAT THIS BUILD CANNOT DRAW (review of #3312, D1): a category added
 * after this build is kept as read and sent back, and the request names the build so the server
 * keeps the stored choice of whatever it cannot name.
 */
describe('the categories this build does not know', () => {
  beforeEach(() => apiFetch.mockReset());

  it('are kept from the read, apart from the ones it draws, and anything malformed is dropped', async () => {
    apiFetch.mockResolvedValueOnce(
      Response.json({ disabled: ['posts', 'a_later_one', 42, 'Not An Id', ''] })
    );
    const snapshot = await fetchNotificationPreferences();
    expect(snapshot.disabled).toEqual(['posts']);
    expect(snapshot.unknownDisabled).toEqual(['a_later_one']);
  });

  it('go back on the save, which names this build', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ disabled: [] }));
    await saveDisabledCategories(['forms'], ['a_later_one']);
    const init = apiFetch.mock.calls[0][1] as RequestInit & { headers: Record<string, string> };
    // `enabled` is always sent: its presence declares this build knows the opt-in reading.
    expect(JSON.parse(String(init.body))).toEqual({
      disabled: ['forms', 'a_later_one'],
      enabled: [],
    });
    expect(init.headers[CLIENT_VERSION_HEADER]).toBe(getClientAppVersion());
  });
});

describe('the push of an opt-in category ("Deux niveaux", owner 2026-11-11)', () => {
  beforeEach(() => apiFetch.mockReset());

  it('is read from enabled, opt-in ids only, and is empty when the server says nothing', async () => {
    apiFetch.mockResolvedValueOnce(
      Response.json({ disabled: [], enabled: ['suggestions', 'posts', 'a_later_one'] })
    );
    expect((await fetchNotificationPreferences()).pushEnabled).toEqual(['suggestions']);
    apiFetch.mockResolvedValueOnce(Response.json({ disabled: [] }));
    expect((await fetchNotificationPreferences()).pushEnabled).toEqual([]);
  });

  it('is sent on the save', async () => {
    apiFetch.mockResolvedValueOnce(Response.json({ disabled: [] }));
    await saveDisabledCategories([], [], ['suggestions']);
    const init = apiFetch.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ disabled: [], enabled: ['suggestions'] });
  });
});
