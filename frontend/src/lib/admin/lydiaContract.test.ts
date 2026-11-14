import {
  fluxSharePercent,
  LydiaContractFormInvalid,
  decimalToHundredths,
  emptyLydiaBand,
  fromLydiaContractForm,
  hundredthsToDecimal,
  toLydiaContractForm,
  type LydiaContractSettings,
} from './lydiaContract';

/**
 * The admin form of the Lydia contract terms: decimals typed in euros and percent become cents and
 * basis points, an empty value is "not set" (never zero, never a default), and the round trip keeps
 * what was stored. Every number here is made up for the test.
 */
describe('lydiaContract form', () => {
  it('reads a typed decimal as hundredths, a comma or a dot', () => {
    expect(decimalToHundredths('1,5')).toBe(150);
    expect(decimalToHundredths('12.34')).toBe(1234);
    expect(decimalToHundredths('')).toBeNull();
    expect(decimalToHundredths('  ')).toBeNull();
    expect(decimalToHundredths('-1')).toBeNaN();
    expect(decimalToHundredths('1.234')).toBeNaN();
    expect(decimalToHundredths('abc')).toBeNaN();
    expect(hundredthsToDecimal(150)).toBe('1.5');
    expect(hundredthsToDecimal(null)).toBe('');
  });

  it('round-trips stored settings', () => {
    const settings: LydiaContractSettings = {
      anniversary: '2031-03-05',
      fluxTargetCents: 123_400,
      vatBps: 1_550,
      fees: { remote: { percentBps: 77, fixedCents: 3 } },
      bands: [{ fromCents: 50_000, fees: { qr: { percentBps: 12, fixedCents: 0 } } }],
    };
    expect(fromLydiaContractForm(toLydiaContractForm(settings))).toEqual(settings);
  });

  it('leaves a kind with both parts empty unset, and a single empty part at zero', () => {
    const form = toLydiaContractForm({
      anniversary: null,
      fluxTargetCents: null,
      vatBps: null,
      fees: {},
      bands: [],
    });
    form.fees.remote.percent = '2';
    const settings = fromLydiaContractForm(form);
    expect(settings).toEqual({
      anniversary: null,
      fluxTargetCents: null,
      vatBps: null,
      fees: { remote: { percentBps: 200, fixedCents: 0 } },
      bands: [],
    });
  });

  it('refuses a value that is not a number, naming the field', () => {
    const form = toLydiaContractForm({
      anniversary: null,
      fluxTargetCents: null,
      vatBps: null,
      fees: {},
      bands: [],
    });
    form.bands.push(emptyLydiaBand());
    expect(() => fromLydiaContractForm(form)).toThrow(LydiaContractFormInvalid);
    form.bands[0].from = '10';
    form.vat = 'twenty';
    expect(() => fromLydiaContractForm(form)).toThrow(/vatBps/);
  });
});

describe('fluxSharePercent', () => {
  it('is the share of the total, and nothing of a total that is not positive', () => {
    expect(fluxSharePercent(2_500, 10_000)).toBe(25);
    expect(fluxSharePercent(100, 0)).toBeNull();
    expect(fluxSharePercent(100, -50)).toBeNull();
  });
});
