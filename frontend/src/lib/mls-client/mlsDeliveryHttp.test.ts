import {
  resolveMlsPublicUrls,
  assertOkMlsDeliveryResponse,
  deliveryKeepalivePost,
} from './mlsDeliveryHttp';

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
  it('resolves on 2xx without reading body', async () => {
    const res = new Response(null, { status: 204 });
    await expect(assertOkMlsDeliveryResponse(res, 'welcome')).resolves.toBeUndefined();
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
    await expect(deliveryKeepalivePost('https://d.test', 'ping', {}, {})).resolves.toBeNull();
    fetchSpy.mockRestore();
  });
});

describe('resolveMlsPublicUrls (SSR / no window)', () => {
  it('falls back to localhost defaults when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    import.meta.env.VITE_GATEWAY_URL = '';
    import.meta.env.VITE_DELIVERY_URL = '';
    const u = resolveMlsPublicUrls();
    expect(u.baseUrl).toBe('http://localhost:3000');
    expect(u.historyUrl).toBe('http://localhost:3010');
  });
});
