import { signLydiaParams, verifyLydiaSignature } from './lydia-signature';

describe('signLydiaParams', () => {
  it('matches the reference signature from the Lydia API doc example', () => {
    // Doc example: ksort({transaction_identifier:'123', amount:'12'}) then
    // md5("amount=12&transaction_identifier=123&YOUR_PRIVATE_TOKEN")
    const sig = signLydiaParams(
      { transaction_identifier: '123', amount: '12' },
      'YOUR_PRIVATE_TOKEN'
    );
    expect(sig).toBe('71bd559705ba10077edc9763b6f1a7fd');
  });

  it('sorts fields alphabetically regardless of input order', () => {
    const a = signLydiaParams({ b: '2', a: '1' }, 'secret');
    const b = signLydiaParams({ a: '1', b: '2' }, 'secret');
    expect(a).toBe(b);
  });
});

describe('verifyLydiaSignature', () => {
  it('accepts a correctly computed signature', () => {
    const fields = { amount: '12', transaction_identifier: '123' };
    const sig = signLydiaParams(fields, 'YOUR_PRIVATE_TOKEN');
    expect(verifyLydiaSignature(fields, 'YOUR_PRIVATE_TOKEN', sig)).toBe(true);
  });

  it('rejects a tampered field', () => {
    const fields = { amount: '12', transaction_identifier: '123' };
    const sig = signLydiaParams(fields, 'YOUR_PRIVATE_TOKEN');
    expect(verifyLydiaSignature({ ...fields, amount: '13' }, 'YOUR_PRIVATE_TOKEN', sig)).toBe(
      false
    );
  });

  it('rejects a wrong private token', () => {
    const fields = { amount: '12', transaction_identifier: '123' };
    const sig = signLydiaParams(fields, 'YOUR_PRIVATE_TOKEN');
    expect(verifyLydiaSignature(fields, 'wrong-token', sig)).toBe(false);
  });

  it('rejects a malformed signature without throwing', () => {
    const fields = { amount: '12' };
    expect(verifyLydiaSignature(fields, 'secret', 'not-hex')).toBe(false);
  });
});
