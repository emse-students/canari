import { isAllowedCheckoutCallbackUrl } from './checkout-callback-url';

const FRONT = 'https://canari.emse.fr';

describe('isAllowedCheckoutCallbackUrl - the app deep link', () => {
  it.each(['payment', 'stripe'])('accepts fr.emse.canari://%s/success and /cancel', (host) => {
    expect(isAllowedCheckoutCallbackUrl(`fr.emse.canari://${host}/success?x=1`, FRONT)).toBe(true);
    expect(isAllowedCheckoutCallbackUrl(`fr.emse.canari://${host}/cancel`, FRONT)).toBe(true);
  });

  it.each(['callback', 'chat', 'evil'])('refuses the host %s', (host) => {
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
