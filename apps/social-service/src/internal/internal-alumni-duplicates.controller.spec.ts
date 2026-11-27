import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalAlumniDuplicatesController } from './internal-alumni-duplicates.controller';
import type { AdminQueuesService } from '../admin-queues/admin-queues.service';

describe('InternalAlumniDuplicatesController', () => {
  const env = { ...process.env };
  const announceAlumniDuplicate = jest.fn().mockResolvedValue(3);
  const announceAlumniDuplicates = jest.fn().mockResolvedValue(2);
  const queueChanged = jest.fn().mockResolvedValue(undefined);
  const controller = new InternalAlumniDuplicatesController({
    announceAlumniDuplicate,
    announceAlumniDuplicates,
    queueChanged,
  } as unknown as AdminQueuesService);
  const duplicate = '0b9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f10';

  beforeEach(() => {
    process.env.INTERNAL_SECRET = 'shared-secret';
    announceAlumniDuplicate.mockClear();
    announceAlumniDuplicates.mockClear();
    queueChanged.mockClear();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('announces a flagged duplicate to the admins and answers how many were told', async () => {
    expect(await controller.flagged('shared-secret', { duplicateUuid: duplicate })).toEqual({
      told: 3,
    });
    expect(announceAlumniDuplicate).toHaveBeenCalledWith(duplicate);
  });

  it('refuses a malformed duplicate id, and a caller without the internal secret', async () => {
    await expect(
      controller.flagged('shared-secret', { duplicateUuid: 'not-a-uuid' })
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.flagged('wrong', { duplicateUuid: duplicate })).rejects.toBeInstanceOf(
      ForbiddenException
    );
    await expect(controller.changed('wrong')).rejects.toBeInstanceOf(ForbiddenException);
    expect(announceAlumniDuplicate).not.toHaveBeenCalled();
    expect(queueChanged).not.toHaveBeenCalled();
  });

  it('a reading that found several announces them together, and refuses an empty, oversized or malformed list', async () => {
    const other = '1c9b4b8e-6c1e-4a54-9f2e-3c2d1a7e9f11';
    expect(await controller.found('shared-secret', { duplicateUuids: [duplicate, other] })).toEqual(
      {
        told: 2,
      }
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

  it('a change tells the badges and writes NO notice: the push is once per duplicate', async () => {
    expect(await controller.changed('shared-secret')).toEqual({ ok: true });
    expect(queueChanged).toHaveBeenCalledWith({ queue: 'alumni-duplicates' });
    expect(announceAlumniDuplicate).not.toHaveBeenCalled();
  });
});
