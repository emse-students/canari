import { signLydiaParams } from './lydia-signature';
import {
  LYDIA_CALLBACK_MAX_FIELDS,
  lydiaCallbackSignedFields,
  verifyLydiaCallback,
} from './lydia-callback-verification';

// Throwaway keys: the measured SHAPE (seven fields, `signed` among them) with invented values.
const KEY = 'throwaway-business-key';
const fields = {
  currency: 'EUR',
  request_id: '42',
  amount: '5.00',
  signed: '0',
  vendor_token: 'vendor-a',
  order_ref: 'form:sub-1',
};
const fetchKey = async (vendorToken: string) => (vendorToken === 'vendor-a' ? KEY : null);

describe('lydiaCallbackSignedFields', () => {
  it('is every received field but sig', () => {
    expect(lydiaCallbackSignedFields({ ...fields, sig: 'x' })).toEqual(fields);
  });

  it('refuses a non-string value, an empty body and an oversized one', () => {
    expect(lydiaCallbackSignedFields({ ...fields, amount: 5 })).toBeNull();
    expect(lydiaCallbackSignedFields({ sig: 'x' })).toBeNull();
    expect(lydiaCallbackSignedFields(undefined)).toBeNull();
    const wide: Record<string, string> = {};
    for (let i = 0; i <= LYDIA_CALLBACK_MAX_FIELDS; i++) wide[`f${i}`] = '1';
    expect(lydiaCallbackSignedFields(wide)).toBeNull();
    expect(lydiaCallbackSignedFields({ a: 'x'.repeat(1000) })).toBeNull();
  });
});

describe('verifyLydiaCallback', () => {
  it('verifies with the key of the Business the vendor_token names', async () => {
    const verdict = await verifyLydiaCallback(
      { ...fields, sig: signLydiaParams(fields, KEY) },
      fetchKey
    );
    expect(verdict).toEqual({ verified: true, vendorToken: 'vendor-a' });
  });

  it('refuses a wrong key, a missing `signed`, an unknown Business and a non-hex sig', async () => {
    const { signed: _s, ...noSigned } = fields;
    const cases = [
      { ...fields, sig: signLydiaParams(fields, 'wrong') },
      { ...noSigned, sig: signLydiaParams(fields, KEY) },
      { ...fields, vendor_token: 'vendor-b', sig: signLydiaParams(fields, KEY) },
      { ...fields, sig: 'not-hex' },
    ];
    const verdicts = await Promise.all(cases.map((b) => verifyLydiaCallback(b, fetchKey)));
    expect(verdicts.map((v) => v.verified)).toEqual([false, false, false, false]);
    expect(verdicts[2]).toEqual({ verified: false, reason: 'no-key' });
  });

  it('never looks a key up for a body it could not verify anyway', async () => {
    const lookup = jest.fn(fetchKey);
    await verifyLydiaCallback({ ...fields, amount: ['5'], sig: 'x' }, lookup);
    await verifyLydiaCallback({ request_id: '1', sig: 'x' }, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});
