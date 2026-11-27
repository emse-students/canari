import { BadRequestException, Logger } from '@nestjs/common';
import { UsersController } from './users.controller';

const DUP = '11111111-1111-4111-8111-111111111111';
const LONELY = '22222222-2222-4222-8222-222222222222';

/**
 * The admin page of Alumni duplicates and the queue it feeds: what the page lists IS what the queue
 * holds (the badge counts the same duplicates), a reading's start is the DATABASE's clock, and "Pas
 * un doublon" is a durable, terminal write.
 */
describe('the Alumni duplicates page and the admin queue', () => {
  const start = new Date('2026-11-27T10:00:00Z');
  const listing = [
    { duplicate: { uuid: DUP }, targets: [] },
    { duplicate: { uuid: LONELY }, targets: [] },
  ];
  let error: jest.SpyInstance;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  function make(queueOver: Record<string, jest.Mock> = {}) {
    const alumniMerge = {
      listDuplicates: jest.fn(async () => ({ duplicates: listing, flaggable: [DUP] })),
      dismiss: jest.fn(async () => undefined),
    };
    const alumniQueue = {
      databaseNow: jest.fn(async () => start),
      reconcile: jest.fn(async () => undefined),
      dismiss: jest.fn(async () => undefined),
      ...queueOver,
    };
    const none = {} as never;
    const controller = new UsersController(
      none,
      none,
      none,
      none,
      none,
      none,
      none,
      alumniMerge as never,
      alumniQueue as never
    );
    return { controller, alumniMerge, alumniQueue };
  }

  it('reconciles the queue with the FLAGGABLE subset of what it lists, from the database clock: an account with no candidate is on the page, not in the queue', async () => {
    const { controller, alumniQueue } = make();
    expect(await controller.listAlumniDuplicates()).toEqual(listing);
    expect(alumniQueue.reconcile).toHaveBeenCalledWith([DUP], start);
  });

  it('answers the page but reconciles nothing when the database clock cannot be read, and says it at error', async () => {
    const { controller, alumniQueue } = make({
      databaseNow: jest.fn().mockRejectedValue(new Error('db down')),
    });
    expect(await controller.listAlumniDuplicates()).toEqual(listing);
    expect(alumniQueue.reconcile).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('NOT read'));
  });

  it('"Pas un doublon" writes the terminal answer, and refuses a malformed id before writing', async () => {
    const { controller, alumniMerge } = make();
    await controller.dismissAlumniDuplicate(DUP, 'admin-1');
    expect(alumniMerge.dismiss).toHaveBeenCalledWith(DUP);
    await expect(controller.dismissAlumniDuplicate('nope', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(alumniMerge.dismiss).toHaveBeenCalledTimes(1);
  });
});
