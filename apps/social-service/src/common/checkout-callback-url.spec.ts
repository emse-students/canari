import { Logger } from '@nestjs/common';
import { isAllowedCheckoutCallbackUrl, resolveCheckoutCallbackUrl } from './checkout-callback-url';

const FRONT = 'https://canari.emse.fr';

describe('isAllowedCheckoutCallbackUrl - the app deep link', () => {
  it('accepts fr.emse.canari://payment/success and /cancel', () => {
    expect(isAllowedCheckoutCallbackUrl('fr.emse.canari://payment/success?x=1', FRONT)).toBe(true);
    expect(isAllowedCheckoutCallbackUrl('fr.emse.canari://payment/cancel', FRONT)).toBe(true);
  });

  it.each(['stripe', 'callback', 'chat', 'evil'])('refuses the host %s', (host) => {
    expect(isAllowedCheckoutCallbackUrl(`fr.emse.canari://${host}/success`, FRONT)).toBe(false);
  });

  it('refuses another path on the payment host', () => {
    expect(isAllowedCheckoutCallbackUrl('fr.emse.canari://payment/other', FRONT)).toBe(false);
  });

  it('still accepts the web return of the app origin only', () => {
    expect(isAllowedCheckoutCallbackUrl(`${FRONT}/forms/success`, FRONT)).toBe(true);
    expect(isAllowedCheckoutCallbackUrl('https://evil.example/forms/success', FRONT)).toBe(false);
  });
});

describe('resolveCheckoutCallbackUrl - a refused URL is a signal, not a silent fallback', () => {
  const FALLBACK = `${FRONT}/forms/success`;
  afterEach(() => jest.restoreAllMocks());

  it('falls back AND warns when the client sent a URL it refuses, without its query', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const got = resolveCheckoutCallbackUrl(
      'fr.emse.canari://stripe/success?session_id=secret',
      FALLBACK,
      FRONT
    );
    expect(got).toBe(FALLBACK);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('REFUSED');
    expect(line).toContain('stripe/success');
    expect(line).not.toContain('secret');
  });

  it('says nothing when the client sent no URL at all, or an accepted one', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(resolveCheckoutCallbackUrl(undefined, FALLBACK, FRONT)).toBe(FALLBACK);
    expect(resolveCheckoutCallbackUrl('fr.emse.canari://payment/cancel', FALLBACK, FRONT)).toBe(
      'fr.emse.canari://payment/cancel'
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
