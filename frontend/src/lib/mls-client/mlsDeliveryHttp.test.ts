import {
  resolveMlsPublicUrls,
  assertOkMlsDeliveryResponse,
  deliveryKeepalivePost,
  DeliveryRefusal,
} from './mlsDeliveryHttp';
import { deliveryUrl, gatewayUrl } from '$lib/utils/apiUrl';
import { NotFromApiError } from '$lib/utils/apiJson';
import { isTransportFailure } from '$lib/utils/transportFailure';

describe('resolveMlsPublicUrls', () => {
  const origGateway = import.meta.env.VITE_GATEWAY_URL;
  const origDelivery = import.meta.env.VITE_DELIVERY_URL;

  afterEach(() => {
    import.meta.env.VITE_GATEWAY_URL = origGateway;
    import.meta.env.VITE_DELIVERY_URL = origDelivery;
    vi.unstubAllGlobals();
  });

  it('treats empty string env as unset and uses window.origin in browser', () => {
    import.meta.env.VITE_GATEWAY_URL = '  ';
    import.meta.env.VITE_DELIVERY_URL = '';
    vi.stubGlobal('window', { location: { origin: 'https://app.example' } });
    const u = resolveMlsPublicUrls();
    expect(u.baseUrl).toBe('https://app.example');
    expect(u.historyUrl).toBe('https://app.example');
  });

  // THE BAKED ORIGIN LOSES TO THE PAGE'S OWN, and this assertion is inverted from what it used to
  // be. The estate answers on two public hostnames; a build bakes one. Preferring the baked value
  // is what sent `/api/mls/security/pin-salt` at the legacy origin from a page served by the new
  // one, where CSP's `connect-src 'self'` refused it and the session could not unlock.
  it('ignores the baked env values in a real browser and uses the page origin', () => {
    import.meta.env.VITE_GATEWAY_URL = 'https://gw.test';
    import.meta.env.VITE_DELIVERY_URL = 'https://delivery.test';
    vi.stubGlobal('window', { location: { origin: 'https://served-from.example' } });
    const u = resolveMlsPublicUrls();
    expect(u.baseUrl).toBe('https://served-from.example');
    expect(u.historyUrl).toBe('https://served-from.example');
  });

  // The Tauri half of this contract is NOT asserted here on purpose: `import.meta.env` is baked at
  // transform time, so no test at this level can make the delegate see a different value. It is
  // covered where the value is an argument - `resolveServiceUrl` in `apiUrl.test.ts`.
});

describe('assertOkMlsDeliveryResponse', () => {
  it('resolves on a 2xx the delivery service answered, without reading its body', async () => {
    const res = Response.json({ status: 'queued' });
    await expect(assertOkMlsDeliveryResponse(res, 'welcome')).resolves.toBeUndefined();
    expect(res.bodyUsed).toBe(false);
  });

  it('reads a portal 200 (text/html) as no answer, never as a delivered Welcome', async () => {
    const res = new Response('<html>log in to the Wi-Fi</html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const failure = await assertOkMlsDeliveryResponse(res, 'welcome').catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(NotFromApiError);
    expect(isTransportFailure(failure)).toBe(true);
  });

  it('throws with status, context, and body preview on error', async () => {
    const res = new Response('x'.repeat(400), { status: 409, statusText: 'Conflict' });
    try {
      await assertOkMlsDeliveryResponse(res, 'sendWelcome');
      expect.fail('expected throw');
    } catch (e) {
      const msg = String(e);
      expect(msg).toMatch(/Could not send the secure invitation \(sendWelcome\)/);
      expect(msg).toMatch(/409/);
    }
  });
});

describe('deliveryKeepalivePost', () => {
  it('POSTs JSON with keepalive and merges Content-Type', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    await deliveryKeepalivePost(
      'https://delivery.test',
      'ack',
      { id: 'q1' },
      { Authorization: 'Bearer t' }
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://delivery.test/api/mls/ack');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    const body = typeof init.body === 'string' ? init.body : '';
    expect(body).toContain('q1');
    fetchSpy.mockRestore();
  });

  it('swallows fetch rejections (fire-and-forget) and reports NO answer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      deliveryKeepalivePost('https://d.test', 'ping', {}, { Authorization: 'Bearer x' })
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  it('returns the JSON body, so an endpoint that ANSWERS can be heard', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'no_peer_online' }), { status: 200 })
      );
    await expect(
      deliveryKeepalivePost('https://d.test', 'history-request', {}, {})
    ).resolves.toEqual({ status: 'no_peer_online' });
    fetchSpy.mockRestore();
  });

  it.each([
    ['a non-2xx', new Response(JSON.stringify({ status: 'no_peer_online' }), { status: 503 })],
    ['an empty body', new Response(null, { status: 200 })],
    ['a non-JSON body', new Response('<html>', { status: 200 })],
    ['a JSON array', new Response('[1,2]', { status: 200 })],
  ])('reports NO answer on %s, which is never the same as a negative one', async (_label, res) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(deliveryKeepalivePost('https://d.test', 'ping', {}, {})).resolves.toBeNull();
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  it.each([
    [
      'a 403 NOT_A_MEMBER',
      new Response(JSON.stringify({ code: 'NOT_A_MEMBER', message: 'anything' }), { status: 403 }),
      'not_a_member',
      403,
    ],
    [
      'a 409 awaiting_admission',
      new Response(JSON.stringify({ error: 'awaiting_admission', message: 'x' }), { status: 409 }),
      'awaiting_admission',
      409,
    ],
  ])('types %s as a refusal - an answer, never "no answer"', async (_l, res, reason, status) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const answer = await deliveryKeepalivePost('https://d.test', 'history-request', {}, {});

    expect(answer).toBeInstanceOf(DeliveryRefusal);
    expect(answer).toMatchObject({ reason, httpStatus: status });
    expect(warn.mock.calls.flat().join(' ')).toContain(`history-request answered ${status}`);
    fetchSpy.mockRestore();
    warn.mockRestore();
  });

  it.each([
    [
      'a 403 with no contract code',
      new Response(JSON.stringify({ message: 'x' }), { status: 403 }),
    ],
    [
      'a 403 whose MESSAGE names the refusal',
      new Response(JSON.stringify({ message: 'NOT_A_MEMBER' }), { status: 403 }),
    ],
    [
      'a 409 that is another conflict',
      new Response(JSON.stringify({ error: 'other' }), { status: 409 }),
    ],
  ])('reads %s as no answer - from the status and code, never the message', async (_l, res) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(res);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(deliveryKeepalivePost('https://d.test', 'ping', {}, {})).resolves.toBeNull();
    expect(warn.mock.calls.flat().join(' ')).toContain('ping answered');
    fetchSpy.mockRestore();
    warn.mockRestore();
  });
});

describe('resolveMlsPublicUrls (SSR / no window)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // IT DELEGATES, AND THAT IS ALL THIS FILE CAN ASSERT WITHOUT A WINDOW. The value it returns is
  // baked from the environment at transform time, so assigning `import.meta.env` here changes
  // nothing: the localhost defaults this used to expect held on CI (no `.env`) and failed on any
  // workstation that had one. The fallback itself is asserted on `resolveServiceUrl`, in
  // `apiUrl.test.ts`, where the baked value is an argument.
  it('answers the gateway and delivery resolvers, whatever they were baked with', () => {
    vi.stubGlobal('window', undefined);
    expect(resolveMlsPublicUrls()).toEqual({ baseUrl: gatewayUrl(), historyUrl: deliveryUrl() });
  });
});
