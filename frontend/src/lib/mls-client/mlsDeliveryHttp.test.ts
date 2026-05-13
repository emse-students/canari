import { describe, it, expect, vi, afterEach } from 'vitest';
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

  it('uses trimmed non-empty env values', () => {
    import.meta.env.VITE_GATEWAY_URL = ' https://gw.test ';
    import.meta.env.VITE_DELIVERY_URL = 'https://delivery.test';
    vi.stubGlobal('window', { location: { origin: 'https://ignored' } });
    const u = resolveMlsPublicUrls();
    expect(u.baseUrl).toBe('https://gw.test');
    expect(u.historyUrl).toBe('https://delivery.test');
  });
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
      expect(msg).toMatch(/Impossible d'envoyer l'invitation sécurisée \(sendWelcome\)/);
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

  it('swallows fetch rejections (fire-and-forget)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      deliveryKeepalivePost('https://d.test', 'ping', {}, { Authorization: 'Bearer x' })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    fetchSpy.mockRestore();
    warn.mockRestore();
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
