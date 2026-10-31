import {
  ADDRESSED_HISTORY_CAPABILITY,
  JOIN_ASK_CAPABILITY,
  gatewaySocketUrl,
} from './frameDelivery';
import webMlsService from '$lib/services/WebMlsService.ts?raw';
import tauriMlsService from '$lib/services/TauriMlsService.ts?raw';

/**
 * Step A, rule 6 (docs/wiki/protocols/history-answer-addressing.md): a socket that does not declare
 * the capability makes its whole device unaddressable, and the gateway's edge filter drops an
 * addressed frame on it. A socket opener that forgot `caps=` would therefore silently turn history
 * answers off for every device it runs on - so both openers build their URL through ONE function.
 */
describe('the gateway socket URL', () => {
  it('declares the addressed-history and join-ask capabilities, with or without a token', () => {
    for (const token of [undefined, 'tok']) {
      const { url } = gatewaySocketUrl('wss://example.test', 'device 1', token);
      const query = new URL(url).searchParams;

      expect(query.get('device_id')).toBe('device 1');
      expect(query.get('caps')?.split(',')).toEqual([
        ADDRESSED_HISTORY_CAPABILITY,
        JOIN_ASK_CAPABILITY,
      ]);
      expect(query.get('token')).toBe(token ?? null);
    }
  });

  it('never writes the token into the line it logs', () => {
    const { url, redacted } = gatewaySocketUrl('wss://example.test', 'd1', 'secret-token');

    expect(url).toContain('secret-token');
    expect(redacted).not.toContain('secret-token');
  });

  it.each([
    ['WebMlsService', webMlsService],
    ['TauriMlsService', tauriMlsService],
  ])('%s opens its socket through it', (_name, source) => {
    expect(source).toMatch(/gatewaySocketUrl\(/);
    expect(source).not.toMatch(/\/api\/ws\?device_id=/);
  });
});
