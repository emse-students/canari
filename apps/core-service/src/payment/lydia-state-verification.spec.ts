import { createHash } from 'crypto';
import { lydiaStateSignedFields, verifyLydiaStateSignature } from './lydia-state-verification';

const KEY = 'business-private-token-for-test';
const UUID = '077f2efc0a1b4c2d8e9f00112233445a';

/** Lydia's documented composition, written out by hand rather than through `signLydiaParams`. */
const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('verifyLydiaStateSignature', () => {
  it('verifies md5("amount=<sent>&request_uuid=<uuid>&<key>") for a read by uuid', () => {
    const signature = md5(`amount=12.50&request_uuid=${UUID}&${KEY}`);
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1250, KEY, signature)).toBe('verified');
  });

  it('verifies over order_ref for a read by order_ref', () => {
    const orderRef = 'product:p:c';
    const signature = md5(`amount=0.50&order_ref=${orderRef}&${KEY}`);
    expect(verifyLydiaStateSignature({ orderRef }, 50, KEY, signature)).toBe('verified');
  });

  it('writes the amount exactly as request/do sent it', () => {
    expect(lydiaStateSignedFields({ requestUuid: UUID }, 1000)).toEqual({
      amount: '10.00',
      request_uuid: UUID,
    });
  });

  it('answers mismatch for ANOTHER amount: the request was not issued for what the row expects', () => {
    const signature = md5(`amount=12.50&request_uuid=${UUID}&${KEY}`);
    expect(verifyLydiaStateSignature({ requestUuid: UUID }, 1251, KEY, signature)).toBe('mismatch');
  });

  it('answers mismatch for another request, another key, or a malformed value', () => {
    const signature = md5(`amount=12.50&request_uuid=${UUID}&${KEY}`);
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
