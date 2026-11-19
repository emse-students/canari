/**
 * The Lydia contract service: a value not entered is NOT CONFIGURED (a null schedule, a named gap in
 * the counter, a WARN) and never a default; a write is parsed whole and refused by field; the counter
 * measures the year the anniversary puts today in, and a failed measure is a 502, never a zero.
 * Every number here is made up for the test.
 */
import axios from 'axios';
import { BadGatewayException, BadRequestException, Logger } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { PlatformConfig } from './entities/platform-config.entity';
import { LYDIA_FEES_NOT_A_PRICE_EDITOR, LydiaContractService } from './lydia-contract.service';

jest.mock('axios');
const mockedAxios = axios as unknown as { get: jest.Mock };

function serviceWith(row: Partial<PlatformConfig> | null) {
  const repo = {
    findOne: jest.fn().mockResolvedValue(row ? { id: 1, ...row } : null),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  return {
    repo,
    service: new LydiaContractService(repo as unknown as Repository<PlatformConfig>),
  };
}

const TERMS = {
  fluxTargetCents: 900_000,
  vatBps: 1_234,
  fees: { remote: { percentBps: 77, fixedCents: 3 } },
  bands: [
    { fromCents: 0, fees: { remote: { percentBps: 99, fixedCents: 3 } } },
    { fromCents: 100_000, fees: { remote: { percentBps: 88, fixedCents: 3 } } },
  ],
};

let warn: jest.SpyInstance;
let error: jest.SpyInstance;

beforeEach(() => {
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  mockedAxios.get = jest.fn();
});

afterEach(() => jest.restoreAllMocks());

describe('assertMayReadFeeSchedule', () => {
  it('answers a global admin without asking social-service', async () => {
    const { service } = serviceWith({ lydiaContract: TERMS });
    await expect(service.assertMayReadFeeSchedule('admin-id', true)).resolves.toBeUndefined();
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });

  it('answers a price editor, as social-service decides', async () => {
    const { service } = serviceWith({ lydiaContract: TERMS });
    mockedAxios.get.mockResolvedValue({ data: { ok: true } });
    await expect(service.assertMayReadFeeSchedule('editor-id', false)).resolves.toBeUndefined();
    expect(mockedAxios.get.mock.calls[0][0]).toContain('may-edit-a-price?userId=editor-id');
  });

  it('refuses everyone else with the typed 403', async () => {
    const { service } = serviceWith({ lydiaContract: TERMS });
    mockedAxios.get.mockResolvedValue({ data: { ok: false } });
    await expect(service.assertMayReadFeeSchedule('student-id', false)).rejects.toMatchObject({
      response: { code: LYDIA_FEES_NOT_A_PRICE_EDITOR },
    });
  });

  it('is a 502 when the check cannot be made, never an answer', async () => {
    const { service } = serviceWith({ lydiaContract: TERMS });
    mockedAxios.get.mockRejectedValue(new Error('ECONNRESET'));
    await expect(service.assertMayReadFeeSchedule('editor-id', false)).rejects.toMatchObject({
      response: { code: 'LYDIA_FEES_CHECK_UNREADABLE' },
    });
  });
});

describe('feeSchedule', () => {
  it('is null and accuses at WARN while nothing is entered', async () => {
    const { service } = serviceWith({
      lydiaContractAnniversary: '2031-03-05',
      lydiaContract: null,
    });
    await expect(service.feeSchedule()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT CONFIGURED'));
  });

  it('is null while the VAT is missing, even with a fee entered', async () => {
    const { service } = serviceWith({
      lydiaContract: { ...TERMS, vatBps: null },
    });
    await expect(service.feeSchedule()).resolves.toBeNull();
  });

  it('is the remote fee and the VAT once both are entered', async () => {
    const { service } = serviceWith({ lydiaContract: TERMS });
    await expect(service.feeSchedule()).resolves.toEqual({
      percentBps: 77,
      fixedCents: 3,
      vatBps: 1_234,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads a stored value that no longer parses as unset, at ERROR', async () => {
    const { service } = serviceWith({ lydiaContract: { vatBps: 'twenty' } });
    await expect(service.feeSchedule()).resolves.toBeNull();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('do not parse'));
  });
});

describe('putSettings', () => {
  it('writes the whole parsed set and logs no value', async () => {
    const { service, repo } = serviceWith({ lydiaContract: null });
    await service.putSettings({ anniversary: '2031-03-05', ...TERMS }, 'ADMIN-123456789');
    expect(repo.update).toHaveBeenCalledWith(
      { id: 1 },
      { lydiaContractAnniversary: '2031-03-05', lydiaContract: TERMS }
    );
    const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(line).toContain('by=ADMIN-12');
    expect(line).not.toContain('900000');
    expect(line).not.toContain('1234');
  });

  it('refuses a bad field with a typed 400 and writes nothing', async () => {
    const { service, repo } = serviceWith({ lydiaContract: null });
    const put = service.putSettings({ anniversary: '2031-03-05', vatBps: -5 }, 'admin');
    await expect(put).rejects.toBeInstanceOf(BadRequestException);
    await expect(put).rejects.toMatchObject({
      response: { code: 'LYDIA_CONTRACT_INVALID', field: 'vatBps' },
    });
    expect(repo.update).not.toHaveBeenCalled();
  });
});

describe('counter', () => {
  const now = new Date('2032-01-10T12:00:00Z');

  it('names every missing value, measures nothing without an anniversary', async () => {
    const { service } = serviceWith({ lydiaContractAnniversary: null, lydiaContract: null });
    const counter = await service.counter(now);
    expect(counter.missing).toEqual(['anniversary', 'target', 'bands']);
    expect(counter.year).toBeNull();
    expect(counter.flux).toBeNull();
    expect(mockedAxios.get).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NOT CONFIGURED'));
  });

  it('measures the current contract year and places the flux in its band', async () => {
    const { service } = serviceWith({
      lydiaContractAnniversary: '2031-03-05',
      lydiaContract: TERMS,
    });
    mockedAxios.get.mockResolvedValue({
      data: {
        paidCents: 150_000,
        paymentCount: 9,
        refundedCents: 20_000,
        refundCount: 1,
        fluxCents: 130_000,
        excludedCents: 7_000,
        excludedCount: 2,
        untraceableCents: 0,
        untraceableCount: 0,
        byAssociation: [],
      },
    });
    const counter = await service.counter(now);
    expect(mockedAxios.get.mock.calls[0][0]).toContain('from=2031-03-05&to=2032-03-05');
    expect(counter.year).toMatchObject({ start: '2031-03-05', end: '2032-03-05', daysLeft: 55 });
    expect(counter.targetCents).toBe(900_000);
    expect(counter.band).toMatchObject({ index: 1, fromCents: 100_000 });
    expect(counter.nextBand).toBeNull();
    expect(counter.missing).toEqual([]);
  });

  it('answers a failed measure with a 502, never a zero flux', async () => {
    const { service } = serviceWith({
      lydiaContractAnniversary: '2031-03-05',
      lydiaContract: TERMS,
    });
    mockedAxios.get.mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(service.counter(now)).rejects.toBeInstanceOf(BadGatewayException);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not be measured'));
  });
});
