import { BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { InternalAlumniDuplicatesController } from './internal-alumni-duplicates.controller';
import type { AdminQueuesService } from '../admin-queues/admin-queues.service';

describe('InternalAlumniDuplicatesController', () => {
  const env = { ...process.env };
  const announceAlumniDuplicates = jest.fn().mockResolvedValue({ told: 2, replayed: false });
  const queueChanged = jest.fn().mockResolvedValue(undefined);
  const controller = new InternalAlumniDuplicatesController({
    announceAlumniDuplicates,
    queueChanged,
  } as unknown as AdminQueuesService);
  const batchId = 'cd'.repeat(32);
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
    expect(
      await controller.found('shared-secret', { duplicateUuids: [duplicate, other], batchId })
    ).toEqual({ told: 2, replayed: false });
    expect(announceAlumniDuplicates).toHaveBeenCalledWith([duplicate, other], batchId);
    for (const bad of [[], ['nope'], Array(201).fill(duplicate), 'x', undefined]) {
      await expect(
        controller.found('shared-secret', { duplicateUuids: bad, batchId })
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    // A batch with no id, or one that is not a digest, is refused: the replay guard needs it.
    for (const badId of [undefined, 'short', 42]) {
      await expect(
        controller.found('shared-secret', { duplicateUuids: [duplicate], batchId: badId })
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(
      controller.found('wrong', { duplicateUuids: [duplicate], batchId })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(announceAlumniDuplicates).toHaveBeenCalledTimes(1);
  });

  it('accepts a full batch of 200 and refuses the 201st', async () => {
    await controller.found('shared-secret', {
      duplicateUuids: Array(200).fill(duplicate),
      batchId,
    });
    expect(announceAlumniDuplicates).toHaveBeenCalledTimes(1);
  });

  it('a change tells the badges and writes NO notice: the push is once per duplicate', async () => {
    expect(await controller.changed('shared-secret')).toEqual({ ok: true });
    expect(queueChanged).toHaveBeenCalledWith({ queue: 'alumni-duplicates' });
    expect(announceAlumniDuplicates).not.toHaveBeenCalled();
  });
});
