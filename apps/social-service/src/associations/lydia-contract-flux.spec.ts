/**
 * `measureLydiaFlux` on canned rows: the flux is paid minus refunded, PostgreSQL's bigint strings are
 * read as numbers, and a payment counted nowhere or a ledger row a bridge contradicts ACCUSES at
 * ERROR. The SQL itself is proven against PostgreSQL in lydia-contract-flux.integration.spec.ts.
 * Every number is made up for the test.
 */
import { Logger } from '@nestjs/common';
import { measureLydiaFlux } from './lydia-contract-flux';

function fakeQuery(payments: Record<string, string | number>, refunds: Record<string, unknown>) {
  return jest.fn(async (sql: string) =>
    sql.includes('FROM lydia_refunds') ? [refunds] : [payments]
  );
}

describe('measureLydiaFlux', () => {
  let logger: Logger;
  let error: jest.SpyInstance;

  beforeEach(() => {
    logger = new Logger('test');
    error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
  });

  it('is paid minus refunded, read from bigint strings', async () => {
    const query = fakeQuery(
      {
        paidCents: '12345',
        paymentCount: 3,
        excludedCents: '500',
        excludedCount: 1,
        untraceableCount: 0,
        contradictionCount: 0,
      },
      { refundedCents: '345', refundCount: 1 }
    );
    await expect(measureLydiaFlux(query, '2031-03-05', '2032-03-05', logger)).resolves.toEqual({
      paidCents: 12_345,
      paymentCount: 3,
      refundedCents: 345,
      refundCount: 1,
      fluxCents: 12_000,
      excludedCents: 500,
      excludedCount: 1,
      untraceableCount: 0,
    });
    expect(query).toHaveBeenCalledWith(expect.any(String), ['2031-03-05', '2032-03-05']);
    expect(error).not.toHaveBeenCalled();
  });

  it('accuses a payment counted nowhere and a ledger row a bridge contradicts', async () => {
    const query = fakeQuery(
      {
        paidCents: '0',
        paymentCount: 0,
        excludedCents: '0',
        excludedCount: 0,
        untraceableCount: 2,
        contradictionCount: 1,
      },
      { refundedCents: '0', refundCount: 0 }
    );
    await measureLydiaFlux(query, '2031-03-05', '2032-03-05', logger);
    const lines = error.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('2 Lydia payment(s) name no Business');
    expect(lines).toContain(
      "1 payment(s) on a Business recorded as enrolled AND held as a bridge's"
    );
  });
});
