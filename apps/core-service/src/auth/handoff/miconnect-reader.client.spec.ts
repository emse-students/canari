import { MiconnectReaderClient } from './miconnect-reader.client';

/**
 * `findAccount` reads the address beside the facts the handoff reads: the mail relay's eligibility
 * asks its DOMAIN (internal-mail.controller.ts). An answer with no address is `null`, never `''`.
 */
describe('MiconnectReaderClient.findAccount', () => {
  const saved = {
    base: process.env.AUTHENTIK_BASE_URL,
    token: process.env.MICONNECT_READER_TOKEN,
    fetch: global.fetch,
  };
  beforeEach(() => {
    process.env.AUTHENTIK_BASE_URL = 'https://miconnect.example';
    process.env.MICONNECT_READER_TOKEN = 'reader-token';
  });
  afterEach(() => {
    global.fetch = saved.fetch;
    for (const [key, value] of [
      ['AUTHENTIK_BASE_URL', saved.base],
      ['MICONNECT_READER_TOKEN', saved.token],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function answering(user: Record<string, unknown>) {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ results: [user] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  const user = { pk: 7, is_active: true, uid: 'user-1', attributes: {}, groups_obj: [] };

  it('reads the address of the account', async () => {
    const fetchMock = answering({ ...user, email: 'a@etu.emse.fr' });
    const account = await new MiconnectReaderClient().findAccount('uuid-1');
    expect(account?.email).toBe('a@etu.emse.fr');
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://miconnect.example/api/v3/core/users/?uuid=uuid-1'
    );
  });

  it('reads an absent or empty address as null', async () => {
    answering({ ...user });
    expect((await new MiconnectReaderClient().findAccount('uuid-1'))?.email).toBeNull();
    answering({ ...user, email: '' });
    expect((await new MiconnectReaderClient().findAccount('uuid-1'))?.email).toBeNull();
  });
});
