/**
 * `measureLydiaFlux` on canned rows: the flux is paid minus refunded, association by association,
 * PostgreSQL's bigint strings are read as numbers, the totals are the SUMS of the per-association
 * rows (one definition of the flux), and a payment counted nowhere or a ledger row a bridge
 * contradicts ACCUSES at ERROR. The SQL itself is proven against PostgreSQL in
 * lydia-contract-flux.integration.spec.ts. Every number and id is made up for the test.
 */
import { Logger } from '@nestjs/common';
import { measureLydiaFlux } from './lydia-contract-flux';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

function fakeQuery(
  payments: Array<Record<string, string | number>>,
  refunds: Array<Record<string, unknown>>,
  names: Array<Record<string, string>> = []
) {
  return jest.fn(async (sql: string) => {
    if (sql.includes('FROM lydia_refunds')) return refunds;
    if (sql.includes('FROM associations WHERE id = ANY')) return names;
    return payments;
  });
}

const zero = {
  paidCents: '0',
  paymentCount: 0,
  excludedCents: '0',
  excludedCount: 0,
  untraceableCents: '0',
  untraceableCount: 0,
  recordWithoutToken: 0,
  contradictionCount: 0,
};

describe('measureLydiaFlux', () => {
  let logger: Logger;
  let error: jest.SpyInstance;

  beforeEach(() => {
    logger = new Logger('test');
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  it('is paid minus refunded per association, the totals being the sums of the rows', async () => {
    const query = fakeQuery(
      [
        { ...zero, associationId: A, paidCents: '2345', paymentCount: 1 },
        {
          ...zero,
          associationId: B,
          paidCents: '10000',
          paymentCount: 2,
          excludedCents: '500',
          excludedCount: 1,
        },
      ],
      [{ associationId: B, refundedCents: '345', refundCount: 1 }],
      [
        { id: A, name: 'Alpha', type: 'association' },
        { id: B, name: 'Beta', type: 'list' },
      ]
    );
    const measure = await measureLydiaFlux(query, '2031-03-05', '2032-03-05', logger);
    expect(measure).toMatchObject({
      paidCents: 12_345,
      paymentCount: 3,
      refundedCents: 345,
      refundCount: 1,
      fluxCents: 12_000,
      excludedCents: 500,
      excludedCount: 1,
      untraceableCount: 0,
    });
    // Sorted by flux, descending; a list has its own row.
    expect(measure.byAssociation.map((s) => [s.name, s.type, s.fluxCents])).toEqual([
      ['Beta', 'list', 9_655],
      ['Alpha', 'association', 2_345],
    ]);
    for (const k of ['paidCents', 'refundedCents', 'fluxCents', 'excludedCents'] as const) {
      expect(measure.byAssociation.reduce((n, s) => n + s[k], 0)).toBe(measure[k]);
    }
    expect(query).toHaveBeenCalledWith(expect.any(String), ['2031-03-05', '2032-03-05']);
    expect(error).not.toHaveBeenCalled();
  });

  it('is empty and zero when nothing was paid', async () => {
    const query = fakeQuery([], []);
    await expect(measureLydiaFlux(query, '2031-03-05', '2032-03-05', logger)).resolves.toEqual(
      expect.objectContaining({ fluxCents: 0, paidCents: 0, byAssociation: [] })
    );
  });

  it('accuses a payment counted nowhere and a ledger row a bridge contradicts', async () => {
    const query = fakeQuery(
      [{ ...zero, associationId: A, untraceableCount: 2, contradictionCount: 1 }],
      []
    );
    await measureLydiaFlux(query, '2031-03-05', '2032-03-05', logger);
    const lines = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('2 Lydia payment(s) name no Business');
    expect(lines).toContain(
      "1 payment(s) on a Business recorded as enrolled AND held as a bridge's"
    );
  });
});
