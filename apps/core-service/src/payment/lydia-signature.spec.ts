import { createHash } from 'crypto';
import {
  phpUrlencode,
  signLydiaParams,
  signLydiaRequest,
  verifyLydiaSignature,
} from './lydia-signature';

const md5 = (text: string) => createHash('md5').update(text).digest('hex');

describe('signLydiaRequest - what Canari SENDS is signed over URL-encoded values (2026-10-30)', () => {
  it('signs a phone number and a JSON array exactly as PHP urlencode writes them', () => {
    const fields = {
      permissions: '["access_collect","access_cashier"]',
      cashier_phone: '+33612345678',
    };
    // Written by hand, as Lydia's PHP side reads it: `+` -> %2B, `[` `"` `,` `]` -> %XX upper case.
    const literal =
      'cashier_phone=%2B33612345678&' +
      'permissions=%5B%22access_collect%22%2C%22access_cashier%22%5D&throwaway-provider-key';
    expect(signLydiaRequest(fields, 'throwaway-provider-key')).toBe(md5(literal));
    // Control: the raw signature of the same fields is a DIFFERENT digest - the one Lydia refused (444).
    expect(signLydiaParams(fields, 'throwaway-provider-key')).not.toBe(md5(literal));
  });

  it('writes a space as + and leaves only [A-Za-z0-9_.-] unescaped', () => {
    expect(phpUrlencode('a b')).toBe('a+b');
    expect(phpUrlencode("!'()*~")).toBe('%21%27%28%29%2A%7E');
    expect(phpUrlencode('Az09_.-')).toBe('Az09_.-');
    expect(phpUrlencode('é@:')).toBe('%C3%A9%40%3A');
  });

  it('equals the raw signature when nothing needs escaping', () => {
    const fields = { amount: '12', transaction_identifier: '123' };
    expect(signLydiaRequest(fields, 'YOUR_PRIVATE_TOKEN')).toBe(
      signLydiaParams(fields, 'YOUR_PRIVATE_TOKEN')
    );
  });
});

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

  it('signs RAW values, as Lydia signs its callbacks (an order_ref with ":" verified this way)', () => {
    // Independent of the implementation: the literal raw string, never `%3A`. URL-encoding here
    // would refuse every callback (docs/wiki/lydia-api.md section 3 and 5b).
    const raw = 'amount=12.50&order_ref=form:abc:0123abcd&KEY';
    expect(signLydiaParams({ order_ref: 'form:abc:0123abcd', amount: '12.50' }, 'KEY')).toBe(
      createHash('md5').update(raw).digest('hex')
    );
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

  it('refuses a correct signature with trailing junk, which a hex decode alone would accept', () => {
    const fields = { amount: '12', transaction_identifier: '123' };
    const sig = signLydiaParams(fields, 'YOUR_PRIVATE_TOKEN');
    // Control: Buffer.from stops at the first non-hex character, so these decode to the SAME bytes.
    expect(Buffer.from(`${sig}zz`, 'hex').equals(Buffer.from(sig, 'hex'))).toBe(true);
    for (const forged of [`${sig}zz`, `${sig}\n`, `${sig} `, `${sig}0`, `${sig}00`]) {
      expect(verifyLydiaSignature(fields, 'YOUR_PRIVATE_TOKEN', forged)).toBe(false);
    }
  });

  it('accepts the signature in upper case, the same 32 hex digits', () => {
    const fields = { amount: '12', transaction_identifier: '123' };
    const sig = signLydiaParams(fields, 'YOUR_PRIVATE_TOKEN');
    expect(verifyLydiaSignature(fields, 'YOUR_PRIVATE_TOKEN', sig.toUpperCase())).toBe(true);
  });
});
