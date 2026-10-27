import { signLydiaParams } from './lydia-signature';
import { lydiaStateSignedFields, verifyLydiaStateSignature } from './lydia-state-verification';

const KEY = 'business-private-token-for-test';
const UUID = '077f2efc0a1b4c2d8e9f00112233445a';

/**
 * Lydia's documented pairs, WRITTEN OUT here rather than taken from `lydiaStateSignedFields`, and
 * signed by `signLydiaParams` - whose own spec pins it to Lydia's published example - so the test
 * names no hash itself.
 */
const sign = (fields: Record<string, string>) => signLydiaParams(fields, KEY);

describe('verifyLydiaStateSignature', () => {
  it('verifies md5("amount=<sent>&request_uuid=<uuid>&<key>") for a read by uuid', () => {
    const signature = sign({ amount: '12.50', request_uuid: UUID });
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1250, KEY, signature)).toBe('verified');
  });

  it('verifies over order_ref for a read by order_ref', () => {
    const orderRef = 'product:p:c';
    const signature = sign({ amount: '0.50', order_ref: orderRef });
    expect(verifyLydiaStateSignature({ orderRef }, 50, KEY, signature)).toBe('verified');
  });

  it('writes the amount exactly as request/do sent it', () => {
    expect(lydiaStateSignedFields({ requestUuid: UUID }, 1000)).toEqual({
      amount: '10.00',
      request_uuid: UUID,
    });
  });

  it('answers mismatch for ANOTHER amount: the request was not issued for what the row expects', () => {
    const signature = sign({ amount: '12.50', request_uuid: UUID });
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1251, KEY, signature)).toBe('mismatch');
  });

  it('answers mismatch for another request, another key, or a malformed value', () => {
    const signature = sign({ amount: '12.50', request_uuid: UUID });
    expect(verifyLydiaStateSignature({ requestUuid: 'f'.repeat(32) }, 1250, KEY, signature)).toBe(
      'mismatch'
    );
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1250, 'other', signature)).toBe(
      'mismatch'
    );
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1250, KEY, `${signature}zz`)).toBe(
      'mismatch'
    );
  });

  it('answers unsigned when Lydia sent no signature', () => {
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1250, KEY, null)).toBe('unsigned');
  });
});
