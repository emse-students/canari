import { signLydiaParams } from './lydia-signature';
import { LydiaPaymentProvider } from './lydia-payment-provider';
import { matchLydiaSignature } from './lydia-signature-match';

const BUSINESS_KEY = 'synthetic-business-key';
const fields = {
  request_id: '12115504',
  amount: '5.00',
  currency: 'EUR',
  order_ref: 'form:sub-1',
  vendor_token: 'vendor-public',
  state: '3',
};

describe('matchLydiaSignature', () => {
  it('names the key, the field set and the algorithm that reproduce a signature', () => {
    const signed = {
      request_id: fields.request_id,
      amount: fields.amount,
      currency: fields.currency,
    };
    const sig = signLydiaParams(signed, BUSINESS_KEY);

    const matches = matchLydiaSignature(fields, sig, ['another-key', BUSINESS_KEY]);

    expect(matches).toContainEqual({
      keyIndex: 1,
      fields: ['request_id', 'amount', 'currency'],
      algorithm: 'sorted-pairs-and-key',
    });
    expect(matches.every((m) => m.keyIndex === 1)).toBe(true);
  });

  it('finds nothing for a wrong key', () => {
    const sig = signLydiaParams({ request_id: '1' }, BUSINESS_KEY);
    expect(matchLydiaSignature(fields, sig, ['wrong'])).toEqual([]);
  });
});

describe('LydiaPaymentProvider.observeRequestCallback', () => {
  const sig = signLydiaParams(
    { request_id: fields.request_id, amount: fields.amount },
    BUSINESS_KEY
  );

  it('reports names and an index, never the key or a value', () => {
    const provider = new LydiaPaymentProvider({ LYDIA_OBSERVE_KEYS: ` ${BUSINESS_KEY} ` });
    const line = provider.observeRequestCallback(fields, sig);
    expect(line).toContain('key#0 fields=[request_id,amount] algorithm=sorted-pairs-and-key');
    expect(line).not.toContain(BUSINESS_KEY);
    expect(line).not.toContain('12115504');
  });

  it('says so when no candidate key is configured or none matches', () => {
    expect(new LydiaPaymentProvider({}).observeRequestCallback(fields, sig)).toBe(
      'observe: no candidate key configured'
    );
    expect(
      new LydiaPaymentProvider({ LYDIA_OBSERVE_KEYS: 'x' }).observeRequestCallback(fields, sig)
    ).toBe('observe: no match over 1 key(s)');
  });
});
