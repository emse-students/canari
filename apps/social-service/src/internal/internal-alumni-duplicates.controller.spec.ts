import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalAlumniDuplicatesController } from './internal-alumni-duplicates.controller';
import type { AdminQueuesService } from '../admin-queues/admin-queues.service';

describe('InternalAlumniDuplicatesController', () => {
  const env = { ...process.env };
  const announceAlumniDuplicates = jest.fn().mockResolvedValue({ told: 2, claimed: 2, skipped: 0 });
  const queueChanged = jest.fn().mockResolvedValue(undefined);
  const controller = new InternalAlumniDuplicatesController({
    announceAlumniDuplicates,
    queueChanged,
  } as unknown as AdminQueuesService);
  const duplicate = '0b9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f10';

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    announceAlumniDuplicates.mockClear();
    queueChanged.mockClear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('a reading that found several announces them together, and refuses an empty, oversized or malformed list', async () => {
    const other = '1c9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f11';
    expect(await controller.found('shared-secret', { duplicateUuids: [duplicate, other] })).toEqual(
      { told: 2, claimed: 2, skipped: 0 }
    );
    expect(announceAlumniDuplicates).toHaveBeenCalledWith([duplicate, other]);
    for (const bad of [[], ['nope'], Array(201).fill(duplicate), 'x', undefined]) {
      await expect(
        controller.found('shared-secret', { duplicateUuids: bad })
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(controller.found('wrong', { duplicateUuids: [duplicate] })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    expect(announceAlumniDuplicates).toHaveBeenCalledTimes(1);
  });

  it('accepts a full batch of 200 and refuses the 201st', async () => {
    await controller.found('shared-secret', {
      duplicateUuids: Array(200).fill(duplicate),
    });
    expect(announceAlumniDuplicates).toHaveBeenCalledTimes(1);
  });

  it('a change tells the badges and writes NO notice: the push is once per duplicate', async () => {
    expect(await controller.changed('shared-secret')).toEqual({ ok: true });
    expect(queueChanged).toHaveBeenCalledWith({ queue: 'alumni-duplicates' });
    expect(announceAlumniDuplicates).not.toHaveBeenCalled();
  });
});
